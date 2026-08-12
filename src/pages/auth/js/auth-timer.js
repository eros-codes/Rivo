import { safeFetch } from "../../../utils/fetch.js";

let _resendTimerInterval = null;

export async function sendCode(email) {
	if (!email || typeof email !== 'string') throw new Error('email required');
	const data = await safeFetch('/api/auth/send-code', {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email }),
	});
	return data;
}

export function startResendTimer(codeResendTimer, storageKey = "resendCooldown") {
	if (_resendTimerInterval) clearInterval(_resendTimerInterval);
	let endsAt = Number(localStorage.getItem(storageKey) || 0);
	if (!endsAt || endsAt <= Date.now()) {
		endsAt = Date.now() + 60_000;
		try { localStorage.setItem(storageKey, String(endsAt)); } catch (e) { /* ignore */ }
	}
	let sec = Math.ceil((endsAt - Date.now()) / 1000);
	codeResendTimer.classList.add("disabled");
	codeResendTimer.style.pointerEvents = "none";
	codeResendTimer.style.opacity = "0.5";

	_resendTimerInterval = setInterval(function () {
		if (sec <= 0) {
			clearInterval(_resendTimerInterval);
			_resendTimerInterval = null;
			try { localStorage.removeItem(storageKey); } catch (e) { /* ignore */ }
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
		sec = Math.ceil((endsAt - Date.now()) / 1000);
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
