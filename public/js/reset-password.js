// Reset password page (opened from the emailed link): sends the link's token
// with the new password, then goes to the sign-in page.
(function () {
	const form = document.getElementById("reset-form");
	const passwordInput = document.getElementById("new-password");
	const confirmInput = document.getElementById("confirm-password");
	const message = document.getElementById("message");
	if (!form || !passwordInput || !confirmInput || !message) return;
	const button = form.querySelector('button[type="submit"]');

	const MIN_LENGTH = 8;
	const MAX_LENGTH = 128;

	function show(text, kind) {
		message.textContent = text || "";
		message.className = "message" + (kind ? ` ${kind}` : "");
	}

	function setBusy(busy) {
		[passwordInput, confirmInput, button].forEach((el) => {
			if (el) el.disabled = busy;
		});
	}

	let token = "";
	try {
		token = (new URLSearchParams(window.location.search).get("token") || "").trim();
	} catch (e) {
		token = "";
	}
	if (!token) {
		show("This link is not complete. Ask for a new reset link from the sign-in page.", "error");
		setBusy(true);
		return;
	}

	let sending = false;
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (sending) return;
		const password = passwordInput.value;
		if (password.length < MIN_LENGTH) {
			show(`Password must be at least ${MIN_LENGTH} characters.`, "error");
			passwordInput.focus();
			return;
		}
		if (password.length > MAX_LENGTH) {
			show("Password is too long.", "error");
			passwordInput.focus();
			return;
		}
		if (password !== confirmInput.value) {
			show("Passwords do not match.", "error");
			confirmInput.focus();
			return;
		}

		sending = true;
		setBusy(true);
		show("Saving…");
		try {
			const res = await fetch("/api/auth/reset-password-with-token", {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token, newPassword: password }),
			});
			const data = await res.json().catch(() => ({}));
			if (res.ok && data && data.success) {
				passwordInput.value = "";
				confirmInput.value = "";
				show("Your password was changed. Taking you to sign in…", "ok");
				// every old session has ended
				try {
					localStorage.removeItem("user");
				} catch (err) {
					/* ignore */
				}
				setTimeout(() => window.location.replace("/auth/auth.html?reset=1"), 1500);
				return;
			}
			if (res.status === 400 && data && data.error === "Invalid or expired reset token") {
				show("This link has expired or was already used. Ask for a new one from the sign-in page.", "error");
				return; // stays disabled: the link cannot be used again
			}
			show((data && data.error) || "Something went wrong. Please try again.", "error");
		} catch (err) {
			show("Connection error. Please try again.", "error");
		}
		sending = false;
		setBusy(false);
	});
})();
