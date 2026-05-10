let _sentCode = null;
let _resendTimerInterval = null;

export function getSentCode() {
	return _sentCode;
}

export function sendCode(email) {
	_sentCode = Math.floor(Math.random() * 900000 + 100000);
	// Do not reveal the raw verification code in alerts for production.
	// Show a brief, non-sensitive message and log the code to console
	// for local/dev debugging only.
	try {
		let masked = "your email";
		if (email && typeof email === "string") {
			const at = email.indexOf("@");
			if (at > 2) masked = email.slice(0, 2) + "..." + email.slice(at);
			else if (at > 0) masked = email[0] + "..." + email.slice(at);
		}
		alert(`A verification code has been sent to ${masked}`);
		// dev-only: print full code to console for debugging
		// (remove or disable in production)
		// eslint-disable-next-line no-console
		console.log("[dev] verification code:", _sentCode, "email:", email ?? "(unknown)");
	} catch (e) {
		// fallback: at least log the code
		// eslint-disable-next-line no-console
		console.log("[dev] verification code:", _sentCode);
	}
	return { code: _sentCode };
}

export function startResendTimer(codeResendTimer) {
	if (_resendTimerInterval) clearInterval(_resendTimerInterval);
	let sec = 60;
	codeResendTimer.classList.add("disabled");
	codeResendTimer.style.pointerEvents = "none";
	codeResendTimer.style.opacity = "0.5";

	_resendTimerInterval = setInterval(function () {
		if (sec === 0) {
			clearInterval(_resendTimerInterval);
			_resendTimerInterval = null;
			codeResendTimer.classList.remove("disabled");
			codeResendTimer.style.pointerEvents = "";
			codeResendTimer.style.opacity = "";
			codeResendTimer.textContent = "Resend";
			return;
		}
		if (sec === 60) {
			codeResendTimer.textContent = "1:00";
		} else if (sec > 9) {
			codeResendTimer.textContent = `0:${sec}`;
		} else {
			codeResendTimer.textContent = `0:0${sec}`;
		}
		sec--;
	}, 1000);
}

export function clearResendTimer() {
	if (_resendTimerInterval) {
		clearInterval(_resendTimerInterval);
		_resendTimerInterval = null;
	}
}

export function clearCodeInputs(verifyForm) {
	if (!verifyForm) return;
	verifyForm.querySelectorAll(".code-digit").forEach((d) => (d.value = ""));
}
