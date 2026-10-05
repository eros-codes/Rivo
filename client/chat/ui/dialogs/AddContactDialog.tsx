// Adding someone by username (with an optional name to show them by).
import { useRef, useState } from "react";
import { ApiError, errorText } from "../../../shared/api/http";
import { useStore } from "../../../shared/lib/store";
import { Dialog } from "../../../shared/ui/Dialog";
import { addContact } from "../../services/actions";
import { closeDialog, openChat } from "../../services/navigation";
import { session } from "../../state/stores";
import { useUi } from "../selectors";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

function AddContact() {
	const myUsername = useStore(session, (s) => s.me?.username ?? "");
	const [name, setName] = useState("");
	const [username, setUsername] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const usernameRef = useRef<HTMLInputElement>(null);

	const fail = (text: string) => {
		setError(text);
		usernameRef.current?.focus();
	};

	const submit = async () => {
		if (busy) return;
		const clean = username.trim().replace(/^@/, "");
		if (!clean) return fail("Username is required");
		if (!USERNAME_RE.test(clean)) return fail("Usernames are 3-30 letters, numbers or underscores");
		if (clean.toLowerCase() === myUsername.toLowerCase()) return fail("That's your own username");
		setBusy(true);
		setError("");
		try {
			const row = await addContact(clean, name);
			// (closes this dialog too)
			openChat(row.conversationId);
		} catch (e) {
			setBusy(false);
			if (e instanceof ApiError && e.status === 404) fail("No one has this username");
			else fail(errorText(e, "Something went wrong. Please try again."));
		}
	};

	return (
		<Dialog className="add-contact-dialog" onClose={closeDialog} labelledBy="add-contact-title">
			<form
				className="add-contact-body"
				noValidate
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<h3 className="add-contact-title" id="add-contact-title">
					Add Contact
				</h3>
				<div className="add-contact-field">
					<label htmlFor="add-contact-name">Name</label>
					<input
						id="add-contact-name"
						type="text"
						placeholder="Contact name (optional)"
						autoComplete="off"
						maxLength={100}
						dir="auto"
						autoFocus
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							// Enter moves on to the username
							if (e.key === "Enter") {
								e.preventDefault();
								usernameRef.current?.focus();
							}
						}}
					/>
				</div>
				<div className="add-contact-field">
					<label htmlFor="add-contact-username">Username</label>
					<input
						ref={usernameRef}
						id="add-contact-username"
						type="text"
						placeholder="@username"
						autoComplete="off"
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						maxLength={31}
						aria-invalid={error ? true : undefined}
						aria-describedby="add-contact-error"
						value={username}
						onChange={(e) => {
							setUsername(e.target.value);
							if (error) setError("");
						}}
					/>
				</div>
				<p className="add-contact-error" id="add-contact-error" role="alert">
					{error}
				</p>
				<div className="add-contact-actions">
					<button type="button" className="add-contact-cancel" onClick={closeDialog}>
						Cancel
					</button>
					<button type="submit" className="add-contact-submit" disabled={busy}>
						{busy ? "Adding…" : "Add"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export function AddContactDialog() {
	const open = useUi((s) => s.dialog === "addContact");
	return open ? <AddContact /> : null;
}
