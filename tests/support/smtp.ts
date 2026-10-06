// A tiny mail server for the tests: speaks just enough SMTP for the server's
// mailer (nodemailer) to sign in and hand over messages, and keeps them. The
// other tests read emails from a file; this one checks the real sending path.
import { createServer, type AddressInfo, type Socket } from "node:net";

export interface SmtpMessage {
	/** MAIL FROM */
	from: string;
	/** RCPT TO */
	to: string[];
	/** the message as sent (headers and body) */
	raw: string;
	/** who signed in to send it */
	user: string | null;
}

export interface SmtpSink {
	port: number;
	messages: SmtpMessage[];
	/** sign-in attempts, in order (user, and whether the password was right) */
	logins: { user: string; ok: boolean }[];
	/** the next message `pred` accepts (one that already came counts) */
	next(pred?: (m: SmtpMessage) => boolean, timeout?: number): Promise<SmtpMessage>;
	close(): Promise<void>;
}

const fromB64 = (s: string) => Buffer.from(s, "base64").toString("utf8");
const address = (arg: string) => /<([^>]*)>/.exec(arg)?.[1] ?? arg.trim();

/** A server that accepts `user` / `pass` (PLAIN or LOGIN) and refuses everything else. */
export async function smtpSink({ user, pass }: { user: string; pass: string }): Promise<SmtpSink> {
	const messages: SmtpMessage[] = [];
	const logins: SmtpSink["logins"] = [];
	const sockets = new Set<Socket>();

	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => undefined);
		socket.setEncoding("utf8");
		const say = (line: string) => socket.write(`${line}\r\n`);
		let buffer = "";
		let signedIn: string | null = null;
		let step: "data" | "plain" | "login-user" | "login-pass" | null = null;
		let loginUser = "";
		let mail: SmtpMessage = { from: "", to: [], raw: "", user: null };
		let body: string[] = [];

		const login = (name: string, password: string) => {
			const ok = name === user && password === pass;
			logins.push({ user: name, ok });
			if (ok) signedIn = name;
			say(ok ? "235 2.7.0 Authentication successful" : "535 5.7.8 Authentication credentials invalid");
		};
		const plain = (b64: string) => {
			const [, name = "", password = ""] = fromB64(b64).split("\0");
			login(name, password);
		};

		say("220 rivo-test-smtp ESMTP");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (let at = buffer.indexOf("\r\n"); at >= 0; at = buffer.indexOf("\r\n")) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 2);
				if (step === "data") {
					if (line !== ".") {
						body.push(line.startsWith("..") ? line.slice(1) : line);
						continue;
					}
					messages.push({ ...mail, raw: body.join("\r\n"), user: signedIn });
					mail = { from: "", to: [], raw: "", user: null };
					body = [];
					step = null;
					say("250 2.0.0 Queued");
					continue;
				}
				if (step === "plain") {
					step = null;
					plain(line);
					continue;
				}
				if (step === "login-user") {
					loginUser = fromB64(line);
					step = "login-pass";
					say("334 UGFzc3dvcmQ6");
					continue;
				}
				if (step === "login-pass") {
					step = null;
					login(loginUser, fromB64(line));
					continue;
				}
				const [command = "", ...rest] = line.split(" ");
				const arg = rest.join(" ");
				switch (command.toUpperCase()) {
					case "EHLO":
						say("250-rivo-test-smtp");
						say("250-AUTH PLAIN LOGIN");
						say("250 8BITMIME");
						break;
					case "HELO":
						say("250 rivo-test-smtp");
						break;
					case "AUTH": {
						const [mechanism = "", initial] = arg.split(" ");
						if (mechanism.toUpperCase() === "PLAIN") {
							if (initial) plain(initial);
							else {
								step = "plain";
								say("334 ");
							}
						} else if (mechanism.toUpperCase() === "LOGIN") {
							if (initial) {
								loginUser = fromB64(initial);
								step = "login-pass";
								say("334 UGFzc3dvcmQ6");
							} else {
								step = "login-user";
								say("334 VXNlcm5hbWU6");
							}
						} else say("504 5.5.4 Unrecognized authentication type");
						break;
					}
					case "MAIL":
						if (!signedIn) {
							say("530 5.7.0 Authentication required");
							break;
						}
						mail.from = address(arg.replace(/^FROM:/i, ""));
						say("250 2.1.0 Ok");
						break;
					case "RCPT":
						mail.to.push(address(arg.replace(/^TO:/i, "")));
						say("250 2.1.5 Ok");
						break;
					case "DATA":
						step = "data";
						say("354 End data with <CR><LF>.<CR><LF>");
						break;
					case "RSET":
						mail = { from: "", to: [], raw: "", user: null };
						say("250 2.0.0 Ok");
						break;
					case "NOOP":
						say("250 2.0.0 Ok");
						break;
					case "QUIT":
						say("221 2.0.0 Bye");
						socket.end();
						break;
					default:
						say("502 5.5.2 Command not recognized");
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

	return {
		port: (server.address() as AddressInfo).port,
		messages,
		logins,
		async next(pred = () => true, timeout = 10_000) {
			const until = Date.now() + timeout;
			for (;;) {
				const hit = messages.find(pred);
				if (hit) return hit;
				if (Date.now() > until) throw new Error(`no such email within ${timeout} ms (${messages.length} received)`);
				await new Promise((r) => setTimeout(r, 50));
			}
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const s of sockets) s.destroy();
				server.close(() => resolve());
			}),
	};
}

/** One part of a message: its headers (lower-case names) and its decoded body. */
interface Part {
	headers: Record<string, string>;
	body: string;
}

function decodeBody(body: string, encoding: string | undefined): string {
	switch ((encoding ?? "").toLowerCase()) {
		case "base64":
			return fromB64(body.replace(/\s+/g, ""));
		case "quoted-printable":
			return Buffer.from(
				body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
				"latin1",
			).toString("utf8");
		default:
			return body;
	}
}

/** A header value with its encoded words (=?UTF-8?B?…?= / =?UTF-8?Q?…?=) decoded. */
function decodeHeader(value: string): string {
	return value.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=\s*/gi, (_, _charset: string, kind: string, text: string) =>
		kind.toUpperCase() === "B" ? fromB64(text) : decodeBody(text.replace(/_/g, " "), "quoted-printable"),
	);
}

function parse(raw: string): Part {
	const at = raw.indexOf("\r\n\r\n");
	const head = at < 0 ? raw : raw.slice(0, at);
	const body = at < 0 ? "" : raw.slice(at + 4);
	const headers: Record<string, string> = {};
	for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = decodeHeader(line.slice(colon + 1).trim());
	}
	return { headers, body };
}

/** Every leaf part of a message (a plain message is its own only part), bodies decoded. */
export function partsOf(raw: string): Part[] {
	const part = parse(raw);
	const boundary = /boundary="?([^";]+)"?/i.exec(part.headers["content-type"] ?? "")?.[1];
	if (!boundary) return [{ headers: part.headers, body: decodeBody(part.body, part.headers["content-transfer-encoding"]) }];
	return part.body
		.split(`--${boundary}`)
		.slice(1)
		.filter((chunk) => !chunk.startsWith("--"))
		.flatMap((chunk) => partsOf(chunk.replace(/^\r\n/, "")));
}

/** A message's headers, and its text and HTML versions. */
export function readMail(raw: string): { headers: Record<string, string>; text: string; html: string } {
	const parts = partsOf(raw);
	const of = (type: string) => parts.find((p) => (p.headers["content-type"] ?? "text/plain").startsWith(type))?.body ?? "";
	return { headers: parse(raw).headers, text: of("text/plain"), html: of("text/html") };
}
