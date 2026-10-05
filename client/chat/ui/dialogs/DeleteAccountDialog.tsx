// Deleting the account, confirmed with the password.
import { useRef, useState } from "react";
import { usersApi } from "../../../shared/api/endpoints";
import { ApiError, errorText } from "../../../shared/api/http";
import { Dialog } from "../../../shared/ui/Dialog";
import { PasswordInput } from "../../../shared/ui/PasswordInput";
import { closeDialog } from "../../services/navigation";
import { accountDeleted } from "../../services/session";
import { useUi } from "../selectors";

function DeleteAccount() {
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const input = useRef<HTMLInputElement>(null);

	const fail = (text: string) => {
		setError(text);
		input.current?.focus();
	};

	const submit = async () => {
		if (busy) return;
		// compared exactly as typed (spaces too)
		if (!password) return fail("Please enter your password.");
		setBusy(true);
		setError("");
		try {
			await usersApi.deleteAccount(password);
			await accountDeleted();
		} catch (e) {
			setBusy(false);
			if (e instanceof ApiError && e.status === 403) fail("Incorrect password.");
			else fail(errorText(e, "Couldn't delete your account. Please try again."));
		}
	};

	return (
		<Dialog className="confirm-dialog" onClose={() => !busy && closeDialog()} closeOnBackdrop={!busy} labelledBy="delete-account-title">
			<form
				className="confirm-dialog-body"
				noValidate
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<h3 className="confirm-dialog-title" id="delete-account-title">
					Delete Account
				</h3>
				<p className="confirm-dialog-desc">This cannot be undone. Your chats stay with the people you talked to, shown as &ldquo;Deleted account&rdquo;. Enter your password to confirm.</p>
				<PasswordInput
					inputRef={input}
					wrapperClass="confirm-dialog-input-wrap password-wrapper"
					className="confirm-dialog-input"
					value={password}
					onChange={(v) => {
						setPassword(v);
						if (error) setError("");
					}}
					placeholder="Password"
					label="Password"
					autoComplete="current-password"
					invalid={!!error}
					autoFocus
				/>
				<p className="confirm-dialog-error" role="alert">
					{error}
				</p>
				<div className="confirm-dialog-actions">
					<button type="button" className="confirm-dialog-btn confirm-dialog-btn--cancel" disabled={busy} onClick={closeDialog}>
						Cancel
					</button>
					<button type="submit" className="confirm-dialog-btn confirm-dialog-btn--danger" disabled={busy}>
						{busy ? "Deleting…" : "Delete"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export function DeleteAccountDialog() {
	const open = useUi((s) => s.dialog === "deleteAccount");
	return open ? <DeleteAccount /> : null;
}
