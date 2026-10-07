// Load test: many people chatting at once on a real server (on the test
// database), measured. How long a message takes to reach the other person
// with 50, 100, 200, 400 … people online, what fails, and what it costs the
// server (CPU, memory, how busy and how late its event loop is).
//
//   npm run loadtest                                  stages 50,100,200,400; 30 s each
//   npm run loadtest -- --stages 20,40 --seconds 15   a short one
//   npm run loadtest -- --compare load-reports/<an earlier run>.json
//   npm run loadtest -- --help
//
// Each person is a real account (signed up the real way) on its own live
// connection, in a one-to-one chat with one other person, open on screen.
// While a stage runs, each of them, every --interval seconds on average,
// types for a second or two (typing:start, typing:stop) and sends a message;
// receiving one, they read it a moment later (message:seen). The same per-
// person limits as production (SOCKET_RATE_MAX 20 per 10 s); the database
// pool as DATABASE_POOL_MAX says (10 if not set).
//
// The report: a table here, and the same figures as JSON (load-reports/, or
// --out) for a later run to be compared with (--compare). It measures; it
// does not pass or fail. This process (the people), the server and
// PostgreSQL share one computer and take CPU from each other: the figures
// are this computer's, so compare runs on the same one.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";
import { parseArgs } from "node:util";
import { io, type Socket } from "socket.io-client";
import type { ClientAcks, ServerEvents } from "../../shared/events.ts";
import { ROOT, startServer, type ProcessStats, type TestServer } from "../support/backend.ts";
import { befriend, newUser, type Payload, type TestUser } from "../support/client.ts";

const HELP = `npm run loadtest -- [options]

  --stages 50,100,200,400  how many people are online in each stage (one after
                           another, each adding people; even numbers: they chat in pairs)
  --seconds 30             how long each stage is measured
  --interval 10            seconds between one person's messages, on average
  --out <file>             where the JSON report goes (load-reports/load-<date>.json)
  --compare <file>         an earlier report: its figures next to these

Needs TEST_DATABASE_URL (as the API tests). Takes about a minute to set up
the accounts, then each stage's --seconds and a few more.`;

// ─── Settings ─────────────────────────────────────────────────────────────

function fail(why: string): never {
	console.error(`${why}\n\n${HELP}`);
	process.exit(2);
}

const options = {
	stages: { type: "string", default: "50,100,200,400" },
	seconds: { type: "string", default: "30" },
	interval: { type: "string", default: "10" },
	out: { type: "string" },
	compare: { type: "string" },
	help: { type: "boolean", short: "h", default: false },
} as const;
let opt: ReturnType<typeof parseArgs<{ options: typeof options }>>["values"];
try {
	opt = parseArgs({ options }).values;
} catch (e) {
	fail((e as Error).message);
}
if (opt.help) {
	console.log(HELP);
	process.exit(0);
}

// (pairs: an odd number goes up by one)
const STAGES = opt.stages.split(",").map((s) => Number(s.trim())).map((n) => n + (n % 2));
if (!STAGES.length || STAGES.some((n) => !Number.isInteger(n) || n < 2)) fail(`--stages: whole numbers of people, 2 or more ("${opt.stages}")`);
if (STAGES.some((n, i) => i > 0 && n <= STAGES[i - 1]!)) fail(`--stages: each stage has more people than the one before ("${opt.stages}")`);
const SECONDS = Number(opt.seconds);
if (!Number.isFinite(SECONDS) || SECONDS < 5) fail(`--seconds: 5 or more ("${opt.seconds}")`);
const INTERVAL = Number(opt.interval);
if (!Number.isFinite(INTERVAL) || INTERVAL < 1) fail(`--interval: 1 or more seconds ("${opt.interval}")`);
const PEOPLE = STAGES.at(-1)!;

/** what the server gets on top of a test server's settings */
const SERVER_ENV = {
	// production's per-person limit (test servers have more room)
	SOCKET_RATE_MAX: "20",
	// warnings and errors only (they are shown at the end): a line per request would be load too
	LOG_LEVEL: "warn",
	// from this command's environment only (not from .env, which the server would read otherwise): the report says which
	DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX || "10",
};

const ACK_TIMEOUT_MS = 10_000;
const NO_ANSWER = `no answer within ${ACK_TIMEOUT_MS / 1000} s`;
/** after a stage's people are online, before it is measured (their presence, opening the chat) */
const SETTLE_MS = 2_000;
/** after a stage, how long messages still on their way may take */
const DRAIN_MS = 5_000;
/** a second or two of typing before each message */
const TYPING_MS: [number, number] = [800, 2_500];
/** a received message is read this long after it arrives */
const READING_MS: [number, number] = [300, 1_500];

// ─── People ───────────────────────────────────────────────────────────────

interface Person {
	user: TestUser;
	conversationId: number;
	socket: Socket | null;
	/** a "seen" is on its way up to this message */
	seenUpTo: number;
	seenTimer: NodeJS.Timeout | null;
}

/** What one stage measured, as it happens. */
interface Tally {
	users: number;
	connectMs: number[];
	connectErrors: string[];
	sendMs: number[];
	deliveryMs: number[];
	seenMs: number[];
	sent: number;
	delivered: number;
	lost: number;
	/** sends (and reads) that failed, by the server's answer */
	failed: Record<string, number>;
	typingSent: number;
	typingRelayed: number;
	/** "seen" receipts that reached the sender */
	receipts: number;
	/** live connections the server ended, or that broke */
	dropped: number;
}

const tally = (users: number): Tally => ({
	users,
	connectMs: [],
	connectErrors: [],
	sendMs: [],
	deliveryMs: [],
	seenMs: [],
	sent: 0,
	delivered: 0,
	lost: 0,
	failed: {},
	typingSent: 0,
	typingRelayed: 0,
	receipts: 0,
	dropped: 0,
});

/** the stage now running (events are counted in it) */
let current = tally(0);
/** messages on their way: text → when it was sent, in which stage, answered yet */
const inflight = new Map<string, { t0: number; stage: Tally; answered: boolean }>();
/** reads (message:seen) waiting to be sent or answered */
let reading = 0;
let closing = false;
let seq = 0;

const between = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo);
/** false when the stage ended first */
const pause = (ms: number, signal: AbortSignal) => wait(ms, undefined, { signal }).then(
	() => true,
	() => false,
);
const countFailure = (t: Tally, why: string) => void (t.failed[why] = (t.failed[why] ?? 0) + 1);

/** An event and the server's answer (or NO_ANSWER), typed by the contract. */
async function request<E extends keyof ClientAcks>(s: Socket, ev: E, data: Payload<E>): Promise<ClientAcks[E]> {
	try {
		return await s.timeout(ACK_TIMEOUT_MS).emitWithAck(ev, data);
	} catch {
		return { error: NO_ANSWER } as ClientAcks[E];
	}
}

/** Brings a person online: the live connection, the chat open. Resolves to how long connecting took (ms). */
function goOnline(p: Person, base: string): Promise<number> {
	return new Promise((done, failed) => {
		const t0 = performance.now();
		const s = io(base, {
			transports: ["websocket"],
			forceNew: true,
			reconnection: false,
			extraHeaders: { Cookie: p.user.cookieHeader(), "User-Agent": p.user.userAgent },
			auth: { visible: true },
		});
		s.once("connect_error", (e: Error) => {
			s.close();
			failed(e);
		});
		s.once("connect", () => {
			const ms = performance.now() - t0;
			p.socket = s;
			s.on("message:new", (m: ServerEvents["message:new"]) => {
				const t = performance.now();
				const f = inflight.get(m.text ?? "");
				if (f) {
					inflight.delete(m.text ?? "");
					f.stage.delivered++;
					f.stage.deliveryMs.push(t - f.t0);
				}
				// read a moment later (several that came meanwhile, in one go)
				p.seenUpTo = Math.max(p.seenUpTo, m.id);
				if (!p.seenTimer) {
					reading++;
					p.seenTimer = setTimeout(() => void read(p).finally(() => reading--), between(READING_MS));
				}
			});
			s.on("message:seen", () => void current.receipts++);
			s.on("typing:start", () => void current.typingRelayed++);
			s.on("disconnect", () => {
				if (!closing) current.dropped++;
			});
			s.emit("conversation:join", { conversationId: p.conversationId });
			done(ms);
		});
	});
}

async function read(p: Person): Promise<void> {
	p.seenTimer = null;
	if (closing || !p.socket) return;
	const stage = current;
	const t0 = performance.now();
	const ack = await request(p.socket, "message:seen", { conversationId: p.conversationId, upToId: p.seenUpTo });
	// (the test is ending: its own closing cut the answer off)
	if (closing) return;
	if (ack.success) stage.seenMs.push(performance.now() - t0);
	else countFailure(stage, `seen: ${ack.error}`);
}

/** One person chatting until the stage ends: wait, type, send. */
async function chat(p: Person, signal: AbortSignal): Promise<void> {
	const s = p.socket;
	if (!s) return;
	const { conversationId } = p;
	// (typing is part of the interval; exponential gaps: people do not take turns)
	const meanGap = Math.max(200, INTERVAL * 1000 - (TYPING_MS[0] + TYPING_MS[1]) / 2);
	for (;;) {
		const gap = Math.min(-Math.log(1 - Math.random()) * meanGap, meanGap * 4);
		if (!(await pause(gap, signal))) return;
		s.emit("typing:start", { conversationId });
		current.typingSent++;
		const typed = await pause(between(TYPING_MS), signal);
		s.emit("typing:stop", { conversationId });
		if (!typed) return;
		// (a message counts in the stage it is sent in)
		const stage = current;
		const n = ++seq;
		const text = `load test message ${n}`;
		const t0 = performance.now();
		const entry = { t0, stage, answered: false };
		inflight.set(text, entry);
		// (unique in the run: a clientId its sender has used before is answered with that earlier message, which is not delivered again)
		const ack = await request(s, "message:send", { conversationId, text, clientId: `load-${String(n).padStart(8, "0")}` });
		if (closing) return;
		if (ack.success && ack.duplicate) {
			countFailure(stage, "taken for a duplicate (clientId)");
			inflight.delete(text);
		} else if (ack.success) {
			entry.answered = true;
			stage.sent++;
			stage.sendMs.push(performance.now() - t0);
		} else {
			countFailure(stage, ack.error);
			// (one that got no answer may still arrive: it is counted delivered then)
			if (ack.error !== NO_ANSWER) inflight.delete(text);
		}
	}
}

/** `fn` for each item, at most `limit` at a time. */
async function inParallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await fn(items[next++]!);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ─── Figures ──────────────────────────────────────────────────────────────

interface Spread {
	count: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
}

function spread(values: number[]): Spread {
	const v = [...values].sort((a, b) => a - b);
	const at = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]! : 0);
	const r = (x: number) => Math.round(x * 10) / 10;
	return { count: v.length, p50: r(at(50)), p95: r(at(95)), p99: r(at(99)), max: r(v.at(-1) ?? 0) };
}

/** One stage's result (as it goes into the JSON report). */
interface StageResult {
	users: number;
	/** how long it was measured (s) */
	seconds: number;
	connect: { ms: Spread; errors: string[] };
	messages: { sent: number; perSecond: number; delivered: number; lost: number; failed: Record<string, number> };
	/** send → the server's answer (stored) */
	sendMs: Spread;
	/** send → on the other person's screen (the number that matters) */
	deliveryMs: Spread;
	/** "seen" → the server's answer */
	seenMs: Spread;
	typing: { sent: number; relayed: number };
	receipts: number;
	dropped: number;
	server: {
		/** % of one core */
		cpu: number;
		/** % of the time the event loop was busy */
		loopBusy: number;
		/** (tick: how often the server's timers can fire; not in reports from before it was measured) */
		loopDelayMs: { p50: number; p99: number; max: number; tick?: number };
		rssMB: number;
		heapUsedMB: number;
		sockets: number;
	} | null;
	/** this process (the people), % of one core */
	loadGeneratorCpu: number;
	verdict: string;
}

const MB = (bytes: number) => Math.round(bytes / 1024 / 1024);

function serverFigures(a: ProcessStats | null, b: ProcessStats | null): StageResult["server"] {
	if (!a || !b) return null;
	const wall = b.at - a.at || 1;
	const cpu = (b.cpu.user + b.cpu.system - a.cpu.user - a.cpu.system) / 1000;
	const active = b.loop.active - a.loop.active;
	const idle = b.loop.idle - a.loop.idle;
	return {
		cpu: Math.round((cpu / wall) * 100),
		loopBusy: Math.round((active / (active + idle || 1)) * 100),
		loopDelayMs: b.loopDelay,
		rssMB: MB(b.memory.rss),
		heapUsedMB: MB(b.memory.heapUsed),
		sockets: b.sockets,
	};
}

/** In a word, for the table: how it would feel to the people in it. */
function verdict(r: Omit<StageResult, "verdict">): string {
	const failed = Object.values(r.messages.failed).reduce((a, b) => a + b, 0);
	if (failed || r.messages.lost || r.dropped || r.connect.errors.length) return "errors";
	if (r.deliveryMs.p95 > 1000) return "too slow";
	if (r.deliveryMs.p95 > 200) return "noticeable";
	// (still fast, but a few more people and every event waits for the ones before it)
	if ((r.server?.loopBusy ?? 0) >= 90) return "at the limit";
	return "smooth";
}

// ─── The run ──────────────────────────────────────────────────────────────

function git(...args: string[]): string {
	try {
		return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

const startedAt = new Date();
const commit = git("rev-parse", "--short", "HEAD");
const report = {
	version: 1,
	startedAt: startedAt.toISOString(),
	finishedAt: "",
	commit: commit ? `${commit}${git("status", "--porcelain") ? " (with uncommitted changes)" : ""}` : "unknown",
	machine: {
		node: process.version,
		platform: `${process.platform} ${process.arch}`,
		cpus: cpus().length,
		cpuModel: cpus()[0]?.model.trim() ?? "",
		memoryGB: Math.round(totalmem() / 1024 ** 3),
	},
	settings: {
		stages: STAGES,
		seconds: SECONDS,
		interval: INTERVAL,
		socketRateMax: Number(SERVER_ENV.SOCKET_RATE_MAX),
		databasePoolMax: Number(SERVER_ENV.DATABASE_POOL_MAX),
	},
	setupSeconds: 0,
	stages: [] as StageResult[],
};

const say = (line: string) => process.stdout.write(`${line}\n`);
const status = (line: string) => process.stdout.write(process.stdout.isTTY ? `\r\x1b[2K${line}` : "");

let server: TestServer | null = null;
const people: Person[] = [];

async function main(): Promise<void> {
	say(`Rivo load test: ${STAGES.join(", ")} people, ${SECONDS} s each, a message every ~${INTERVAL} s per person`);
	server = await startServer(SERVER_ENV);
	const base = server.base;

	// accounts, in pairs, each pair a chat
	const t0 = performance.now();
	const users: TestUser[] = [];
	await inParallel(
		Array.from({ length: PEOPLE }, (_, i) => i),
		10,
		async () => {
			users.push(await newUser(base, "Load"));
			status(`· accounts: ${users.length} / ${PEOPLE}`);
		},
	);
	for (let i = 0; i < users.length; i += 2) {
		const [a, b] = [users[i]!, users[i + 1]!];
		const { conversationId } = await befriend(a, b);
		for (const user of [a, b]) people.push({ user, conversationId, socket: null, seenUpTo: 0, seenTimer: null });
		status(`· chats: ${(i + 2) / 2} / ${PEOPLE / 2}`);
	}
	report.setupSeconds = Math.round((performance.now() - t0) / 1000);
	status("");
	say(`· ${PEOPLE} accounts and ${PEOPLE / 2} chats in ${report.setupSeconds} s`);

	let online = 0;
	for (const size of STAGES) {
		// the stage's new people come online (measured on their own: the stage
		// itself is measured once everyone is chatting)
		const arriving = tally(size);
		current = arriving;
		status(`· ${size} people: coming online`);
		await inParallel(people.slice(online, size), 20, async (p) => {
			try {
				arriving.connectMs.push(await goOnline(p, base));
			} catch (e) {
				arriving.connectErrors.push(String((e as Error)?.message ?? e));
			}
		});
		online = size;
		const stop = new AbortController();
		const chatting = people.slice(0, online).map((p) => chat(p, stop.signal));
		await wait(SETTLE_MS);

		const stage: Tally = { ...tally(size), connectMs: arriving.connectMs, connectErrors: arriving.connectErrors };
		current = stage;
		status(`· ${size} people: chatting for ${SECONDS} s`);
		const before = { server: await server.stats(), cpu: process.cpuUsage(), at: performance.now() };
		await wait(SECONDS * 1000);
		const after = { server: await server.stats(), cpu: process.cpuUsage(before.cpu), at: performance.now() };
		stop.abort();
		status(`· ${size} people: the last messages`);
		await Promise.all(chatting);
		const drainUntil = performance.now() + DRAIN_MS;
		const waiting = () => reading > 0 || [...inflight.values()].some((f) => f.stage === stage);
		while (waiting() && performance.now() < drainUntil) await wait(100);
		for (const [text, f] of inflight) {
			// (one that got no answer is counted as failed already; the ones from before the stage are not its own)
			if (f.stage === stage && f.answered) stage.lost++;
			inflight.delete(text);
		}
		// (anything still arriving belongs to no stage)
		current = tally(size);

		const measured = (after.at - before.at) / 1000;
		const result: Omit<StageResult, "verdict"> = {
			users: size,
			seconds: Math.round(measured),
			connect: { ms: spread(stage.connectMs), errors: stage.connectErrors },
			messages: {
				sent: stage.sent,
				perSecond: Math.round((stage.sent / measured) * 10) / 10,
				delivered: stage.delivered,
				lost: stage.lost,
				failed: { ...stage.failed },
			},
			sendMs: spread(stage.sendMs),
			deliveryMs: spread(stage.deliveryMs),
			seenMs: spread(stage.seenMs),
			typing: { sent: stage.typingSent, relayed: stage.typingRelayed },
			receipts: stage.receipts,
			dropped: stage.dropped,
			server: serverFigures(before.server, after.server),
			loadGeneratorCpu: Math.round(((after.cpu.user + after.cpu.system) / 1000 / (after.at - before.at)) * 100),
		};
		const done: StageResult = { ...result, verdict: verdict(result) };
		report.stages.push(done);
		status("");
		say(`· ${size} people: ${done.messages.perSecond} messages/s, delivered in ${ms(done.deliveryMs.p50)} (half) / ${ms(done.deliveryMs.p95)} (95%) ms — ${done.verdict}`);
	}
}

// ─── The report ───────────────────────────────────────────────────────────

const ms = (v: number) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
const pct = (v: number) => `${v}%`;

interface Row {
	label: string;
	cell(r: StageResult): string;
	/** the figure an earlier run is compared on (lower is better), and how it is written */
	value?: (r: StageResult) => number | undefined;
	show?: (v: number) => string;
}

const failures = (r: StageResult) => Object.values(r.messages.failed).reduce((a, b) => a + b, 0);

const ROWS: Row[] = [
	{ label: "messages / s", cell: (r) => String(r.messages.perSecond) },
	{ label: "send → answer p50 / p95 (ms)", cell: (r) => `${ms(r.sendMs.p50)} / ${ms(r.sendMs.p95)}`, value: (r) => r.sendMs.p95 },
	{ label: "send → delivered p50 (ms)", cell: (r) => ms(r.deliveryMs.p50), value: (r) => r.deliveryMs.p50 },
	{ label: "                 p95 (ms)", cell: (r) => ms(r.deliveryMs.p95), value: (r) => r.deliveryMs.p95 },
	{ label: "                 p99 (ms)", cell: (r) => ms(r.deliveryMs.p99), value: (r) => r.deliveryMs.p99 },
	{ label: "                 max (ms)", cell: (r) => ms(r.deliveryMs.max) },
	{ label: "seen → answer p95 (ms)", cell: (r) => ms(r.seenMs.p95), value: (r) => r.seenMs.p95 },
	{ label: "coming online p95 (ms)", cell: (r) => ms(r.connect.ms.p95) },
	{ label: "failed / lost / dropped", cell: (r) => `${failures(r)} / ${r.messages.lost} / ${r.dropped + r.connect.errors.length}`, value: (r) => failures(r) + r.messages.lost + r.dropped + r.connect.errors.length, show: String },
	{ label: "server CPU (one core = 100%)", cell: (r) => (r.server ? pct(r.server.cpu) : "?"), value: (r) => r.server?.cpu, show: pct },
	{ label: "server event loop busy", cell: (r) => (r.server ? pct(r.server.loopBusy) : "?"), value: (r) => r.server?.loopBusy, show: pct },
	{ label: "server event loop delay p99 (ms)", cell: (r) => (r.server ? ms(r.server.loopDelayMs.p99) : "?"), value: (r) => r.server?.loopDelayMs.p99 },
	{ label: "server memory (RSS)", cell: (r) => (r.server ? `${r.server.rssMB} MB` : "?"), value: (r) => r.server?.rssMB, show: (v) => `${v} MB` },
	{ label: "load generator CPU", cell: (r) => pct(r.loadGeneratorCpu) },
	{ label: "verdict", cell: (r) => r.verdict },
];

function table(header: string[], rows: string[][]): string {
	const widths = header.map((_, c) => Math.max(...[header, ...rows].map((row) => row[c]!.length)));
	const line = (row: string[]) => row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join("   ");
	return [line(header), ...rows.map(line)].join("\n");
}

function printReport(stages: StageResult[]): void {
	if (!stages.length) return;
	say("");
	say(table(["people online", ...stages.map((s) => String(s.users))], ROWS.map((row) => [row.label, ...stages.map(row.cell)])));
	const failed = new Map<string, number>();
	for (const s of stages) for (const [why, n] of Object.entries(s.messages.failed)) failed.set(why, (failed.get(why) ?? 0) + n);
	for (const [why, n] of failed) say(`  failed ${n}×: ${why}`);
	for (const s of stages) for (const e of new Set(s.connect.errors)) say(`  could not come online (${s.users} people): ${e}`);
	// (reports from before the server said its tick have none)
	const tick = Math.max(...stages.map((s) => s.server?.loopDelayMs.tick ?? 0));
	if (tick > 12) say(`  (this computer's timers fire every ~${Math.round(tick)} ms: the event loop delay is only that exact here; "event loop busy" is exact)`);
}

function printComparison(stages: StageResult[], file: string): void {
	let earlier: typeof report;
	try {
		earlier = JSON.parse(readFileSync(file, "utf8"));
		if (earlier.version !== 1 || !Array.isArray(earlier.stages)) throw new Error("not a load test report");
	} catch (e) {
		say(`\n(--compare ${file}: ${(e as Error).message})`);
		return;
	}
	const pairs = stages.flatMap((s) => {
		const old = earlier.stages.find((o) => o.users === s.users);
		return old ? [{ old, latest: s }] : [];
	});
	if (!pairs.length) {
		say(`\n(--compare: ${file} has no stage with the same number of people)`);
		return;
	}
	const change = (row: Row, a: number | undefined, b: number | undefined) => {
		if (a === undefined || b === undefined) return "?";
		const show = row.show ?? ms;
		const d = a === 0 ? (b === 0 ? 0 : Infinity) : Math.round(((b - a) / a) * 100);
		return `${show(a)} → ${show(b)}${d === 0 ? "" : d === Infinity ? " (new)" : ` (${d > 0 ? "+" : ""}${d}%)`}`;
	};
	say(`\nCompared with ${relative(process.cwd(), file)} (${new Date(earlier.startedAt).toLocaleString()}, commit ${earlier.commit}), lower is better:`);
	const rows = ROWS.filter((r) => r.value).map((r) => [r.label, ...pairs.map((p) => change(r, r.value!(p.old), r.value!(p.latest)))]);
	say(table(["people online", ...pairs.map((p) => String(p.latest.users))], rows));
	if (earlier.machine?.cpuModel !== report.machine.cpuModel) say("  (measured on another computer: a difference may be the computer's)");
}

function finish(): void {
	report.finishedAt = new Date().toISOString();
	printReport(report.stages);
	if (opt.compare) printComparison(report.stages, resolve(opt.compare));
	// (this computer's time)
	const d = startedAt;
	const two = (n: number) => String(n).padStart(2, "0");
	const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
	const out = resolve(opt.out ?? join(ROOT, "load-reports", `load-${stamp}.json`));
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(report, null, "\t")}\n`);
	say(`\nReport: ${relative(process.cwd(), out)}`);
	const logged = (server?.log() ?? "").split("\n").filter(Boolean);
	if (logged.length) {
		say(`\nThe server logged ${logged.length} warning/error line(s); the first ones:`);
		for (const line of logged.slice(0, 10)) say(`  ${line.slice(0, 300)}`);
	}
	say(`\n${report.machine.cpus} × ${report.machine.cpuModel}, ${report.machine.memoryGB} GB, Node ${report.machine.node}; commit ${report.commit}`);
	say("This computer ran the people, the server and the database at once: compare runs on the same computer.");
}

async function shutDown(): Promise<void> {
	closing = true;
	for (const p of people) {
		if (p.seenTimer) clearTimeout(p.seenTimer);
		p.socket?.close();
	}
	await server?.stop();
}

let interrupted = false;
process.on("SIGINT", () => {
	if (interrupted) process.exit(130);
	interrupted = true;
	status("");
	say("\nStopped: the stages measured so far.");
	void shutDown().then(() => {
		finish();
		process.exit(130);
	});
});

try {
	await main();
	await shutDown();
	finish();
} catch (e) {
	// (after Ctrl+C, what broke is the stopping itself: its handler reports and exits)
	if (!interrupted) {
		status("");
		console.error(`\nThe load test could not run: ${(e as Error)?.stack ?? e}`);
		await shutDown().catch(() => undefined);
		process.exitCode = 1;
	}
}
