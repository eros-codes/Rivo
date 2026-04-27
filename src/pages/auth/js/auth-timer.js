let _sentCode = null;
let _resendTimerInterval = null;

export function getSentCode() {
	return _sentCode;
}

export function sendCode() {
	_sentCode = Math.floor(Math.random() * 900000 + 100000);
	alert(`Your verification code is: ${_sentCode}`);
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
