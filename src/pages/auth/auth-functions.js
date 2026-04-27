import { showForm, showError, clearError } from "./js/auth-ui.js";
import { isValidEmail, isValidUsername } from "./js/auth-validate.js";
import {
	getSentCode,
	sendCode,
	startResendTimer,
	clearResendTimer,
	clearCodeInputs,
} from "./js/auth-timer.js";
import { loginUser, registerUser } from "./js/auth-api.js";

const theme = localStorage.getItem("rivo-theme") || "light";
if (theme === "dark") document.body.classList.add("dark-mode");

document.addEventListener("DOMContentLoaded", function () {
	// ─── DOM references ───────────────────────────────────────────────────────
	const loginForm = document.querySelector(".form.login");
	const loginUsername = document.getElementById("login-username");
	const loginPassword = document.getElementById("login-password");
	const rememberUser = document.getElementById("remember");
	const forgetPasswordBtn = document.getElementById("forgot-password-btn");
	const showSignUp = document.getElementById("show-signup");

	const signupForm = document.querySelector(".form.signup");
	const signupName = document.getElementById("name");
	const signupEmail = document.getElementById("email");
	const signupUsername = document.getElementById("username");
	const showLogIn = document.getElementById("show-login");

	const verifyForm = document.querySelector(".form.verify");
	const codeResendTimer = document.getElementById("code-resend-timer");
	const backToSignUp = document.getElementById("back-to-signup");

	const passwordForm = document.querySelector(".form.password");
	const passwordInput = document.getElementById("password");
	const confirmPasswordInput = document.getElementById("confirm-password");
	const backToLogin = document.getElementById("back-to-login");

	const forgotForm = document.querySelector(".form.forget-password");
	const forgotInput = document.getElementById("comfirm");
	const backToLogin2 = document.getElementById("back-to-login2");

	const allForms = document.querySelectorAll(".form");

	let forgotPass = false;

	// ─── Auto-fill remembered user ────────────────────────────────────────────
	const remembered = localStorage.getItem("rememberedUser");
	if (remembered && loginUsername) {
		loginUsername.value = remembered;
		if (rememberUser) rememberUser.checked = true;
	}

	// ─── Password toggle (show/hide) ─────────────────────────────────────────
	// Attach a single handler to every toggle button on the page
	document.querySelectorAll('.password-toggle').forEach((btn) => {
		const wrapper = btn.closest('.password-wrapper');
		if (!wrapper) return;
		const input = wrapper.querySelector('.password-input') || wrapper.querySelector('input[type="password"], input[type="text"]');
		if (!input) return;
		btn.addEventListener('click', () => {
			const isHidden = input.type === 'password';
			input.type = isHidden ? 'text' : 'password';
			const eyeOpen = btn.querySelector('.eye-open');
			const eyeClosed = btn.querySelector('.eye-closed');
			if (eyeOpen && eyeClosed) {
				eyeOpen.style.display = isHidden ? '' : 'none';
				eyeClosed.style.display = isHidden ? 'none' : '';
			}
			btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
		});
	});

	// ─── Login form ───────────────────────────────────────────────────────────
	if (loginForm) {
		loginForm.addEventListener("submit", async function (e) {
			e.preventDefault();
			let valid = true;

			if (!loginUsername.value.trim()) {
				showError(
					loginUsername,
					"Please enter your email or username.",
				);
				valid = false;
			} else {
				clearError(loginUsername);
			}

			if (!loginPassword.value || loginPassword.value.length < 8) {
				showError(
					loginPassword,
					"Password must be at least 8 characters.",
				);
				valid = false;
			} else {
				clearError(loginPassword);
			}

			if (!valid) return;

			if (rememberUser?.checked) {
				localStorage.setItem(
					"rememberedUser",
					loginUsername.value.trim(),
				);
			} else {
				localStorage.removeItem("rememberedUser");
			}

			try {
				const { ok, data } = await loginUser(
					loginUsername.value.trim(),
					loginPassword.value,
				);

				if (!ok) {
					showError(
						loginUsername,
						data.error || "Invalid credentials",
					);
					return;
				}

				localStorage.setItem("token", data.token);
				localStorage.setItem("user", JSON.stringify(data.user));
				window.location.href = "../main/main-page.html";
			} catch {
				showError(loginUsername, "Connection error");
			}
		});

		if (forgetPasswordBtn) {
			forgetPasswordBtn.addEventListener("click", () => {
				showForm(allForms, forgotForm);
			});
		}

		if (showSignUp) {
			showSignUp.addEventListener("click", () => {
				showForm(allForms, signupForm);
			});
		}
	}

	// ─── Sign up form ─────────────────────────────────────────────────────────
	if (signupForm) {
		signupForm.addEventListener("submit", (e) => {
			e.preventDefault();
			let valid = true;

			if (
				!signupName.value.trim() ||
				signupName.value.trim().length < 2
			) {
				showError(signupName, "Name must be at least 2 characters.");
				valid = false;
			} else {
				clearError(signupName);
			}

			if (!isValidEmail(signupEmail.value.trim())) {
				showError(signupEmail, "Please enter a valid email address.");
				valid = false;
			} else {
				clearError(signupEmail);
			}

			if (!isValidUsername(signupUsername.value.trim())) {
				showError(
					signupUsername,
					"Username must be 3-20 characters, letters, numbers, or underscores only.",
				);
				valid = false;
			} else {
				clearError(signupUsername);
			}

			if (!valid) return;

			forgotPass = false;
			clearCodeInputs(verifyForm);
			sendCode();
			startResendTimer(codeResendTimer);
			showForm(allForms, verifyForm);
			const firstDigit = verifyForm.querySelector(".code-digit");
			if (firstDigit) firstDigit.focus();
		});

		if (showLogIn) {
			showLogIn.addEventListener("click", () => {
				showForm(allForms, loginForm);
			});
		}
	}

	// ─── Verify form ──────────────────────────────────────────────────────────
	if (verifyForm) {
		const codeDigits = verifyForm.querySelectorAll(".code-digit");
		const codeHidden = verifyForm.querySelector("#code-hidden");

		codeDigits.forEach((input, idx) => {
			input.addEventListener("input", () => {
				input.value = input.value.replace(/\D/g, "").slice(-1);
				if (input.value && idx < codeDigits.length - 1) {
					codeDigits[idx + 1].focus();
				}
			});

			input.addEventListener("keydown", (e) => {
				if (e.key === "Backspace" && !input.value && idx > 0) {
					codeDigits[idx - 1].focus();
				} else if (e.key === "ArrowLeft" && idx > 0) {
					e.preventDefault();
					codeDigits[idx - 1].focus();
				} else if (
					e.key === "ArrowRight" &&
					idx < codeDigits.length - 1
				) {
					e.preventDefault();
					codeDigits[idx + 1].focus();
				}
			});

			input.addEventListener("paste", (e) => {
				e.preventDefault();
				const paste = (e.clipboardData || window.clipboardData)
					.getData("text")
					.replace(/\D/g, "");
				for (let i = 0; i < codeDigits.length; i++) {
					codeDigits[i].value = paste[i] || "";
				}
				const focusIndex = Math.min(
					paste.length,
					codeDigits.length - 1,
				);
				codeDigits[focusIndex].focus();
			});
		});

		verifyForm.addEventListener("submit", function (e) {
			e.preventDefault();
			const code = Array.from(codeDigits)
				.map((i) => i.value || "")
				.join("");

			if (code.length < codeDigits.length) {
				alert("Please enter the full 6-digit code.");
				codeDigits[0].focus();
				return;
			}

			if (codeHidden) codeHidden.value = code;

			if (String(getSentCode()) === code) {
				clearCodeInputs(verifyForm);
				showForm(allForms, passwordForm);
				if (passwordInput) passwordInput.focus();
			} else {
				alert("The code entered does not match. Please try again.");
				clearCodeInputs(verifyForm);
				codeDigits[0].focus();
			}
		});

		if (codeResendTimer) {
			codeResendTimer.addEventListener("click", () => {
				if (codeResendTimer.classList.contains("disabled")) return;
				clearCodeInputs(verifyForm);
				sendCode();
				startResendTimer(codeResendTimer);
			});
		}

		if (backToSignUp) {
			backToSignUp.addEventListener("click", () => {
				clearResendTimer();
				forgotPass
					? showForm(allForms, forgotForm)
					: showForm(allForms, signupForm);
			});
		}
	}

	// ─── Password form ────────────────────────────────────────────────────────
	if (passwordForm) {
		passwordForm.addEventListener("submit", async function (e) {
			e.preventDefault();
			let valid = true;

			if (!passwordInput.value || passwordInput.value.length < 8) {
				showError(
					passwordInput,
					"Password must be at least 8 characters.",
				);
				valid = false;
			} else {
				clearError(passwordInput);
			}

			if (confirmPasswordInput.value !== passwordInput.value) {
				showError(confirmPasswordInput, "Passwords do not match.");
				valid = false;
			} else {
				clearError(confirmPasswordInput);
			}

			if (!valid) return;

			if (forgotPass) {
				showForm(allForms, loginForm);
				alert("Password reset successfully. Please log in.");
			} else {
				try {
					const { ok, data } = await registerUser(
						signupName.value.trim(),
						signupEmail.value.trim(),
						signupUsername.value.trim(),
						passwordInput.value,
					);

					if (!ok) {
						showError(
							passwordInput,
							data.error || "Registration failed",
						);
						return;
					}

					showForm(allForms, loginForm);
					alert("Account created! Please log in.");
				} catch {
					showError(passwordInput, "Connection error");
				}
			}
		});

		if (backToLogin) {
			backToLogin.addEventListener("click", () => {
				showForm(allForms, loginForm);
			});
		}
	}

	// ─── Forgot password form ─────────────────────────────────────────────────
	if (forgotForm) {
		forgotForm.addEventListener("submit", function (e) {
			e.preventDefault();

			if (
				!forgotInput.value.trim() ||
				forgotInput.value.trim().length < 6
			) {
				showError(
					forgotInput,
					"Please enter a valid email or username.",
				);
				return;
			}
			clearError(forgotInput);

			forgotPass = true;
			clearCodeInputs(verifyForm);
			sendCode();
			startResendTimer(codeResendTimer);
			showForm(allForms, verifyForm);
			const firstDigit = verifyForm?.querySelector(".code-digit");
			if (firstDigit) firstDigit.focus();
		});

		if (backToLogin2) {
			backToLogin2.addEventListener("click", () => {
				showForm(allForms, loginForm);
			});
		}
	}
});