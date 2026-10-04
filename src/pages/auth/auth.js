import { showForm, showError, clearError } from "./js/auth-ui.js";
import { isValidEmail, isValidUsername, isValidPassword } from "./js/auth-validate.js";
import {
	sendCode,
	startResendTimer,
	clearResendTimer,
	clearCodeInputs,
} from "./js/auth-timer.js";
import { loginUser, registerUser, requestPasswordReset, checkAvailability } from "./js/auth-api.js";

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

	function setFormControlsDisabled(form, disabled) {
		if (!form) return;
		const controls = form.querySelectorAll('input,button,select,textarea');
		controls.forEach((el) => {
			if (!el) return;
			// keep hidden inputs enabled
			if (el.type && el.type.toLowerCase() === 'hidden') return;
			try {
				el.disabled = Boolean(disabled);
				if (disabled) {
					el.classList.add('sending');
					el.setAttribute('aria-disabled', 'true');
				} else {
					el.classList.remove('sending');
					el.removeAttribute('aria-disabled');
				}
			} catch (e) {
				/* ignore */
			}
		});
	}

	let forgotPass = false;
	let _verificationEmail = null;

	// A friendly note above the login fields (not an error)
	function showLoginNotice(text) {
		if (!loginForm) return;
		let note = loginForm.querySelector(".auth-notice");
		if (!note) {
			note = document.createElement("p");
			note.className = "auth-notice";
			note.setAttribute("role", "status");
			note.style.cssText =
				"margin:-0.25rem 0 0.75rem;font-size:0.8rem;line-height:1.5;color:#2f9e63;";
			const title = loginForm.querySelector(".form-title");
			if (title) title.insertAdjacentElement("afterend", note);
			else loginForm.prepend(note);
		}
		note.textContent = text || "";
		note.hidden = !text;
	}

	// Back from the reset-password page
	try {
		const params = new URLSearchParams(window.location.search);
		if (params.get("reset") === "1") {
			showLoginNotice("Your password was changed. Sign in with your new password.");
			history.replaceState(history.state, "", window.location.pathname);
		}
	} catch (e) {
		/* ignore */
	}

	// ─── Auto-fill remembered user ────────────────────────────────────────────
	const remembered = localStorage.getItem("rememberedUser");
	if (remembered && loginUsername) {
		loginUsername.value = remembered;
		if (rememberUser) rememberUser.checked = true;
	}

	// ─── Password toggle (show/hide) ─────────────────────────────────────────
	// Attach a single handler to every toggle button on the page
	document.querySelectorAll(".password-toggle").forEach((btn) => {
		const wrapper = btn.closest(".password-wrapper");
		if (!wrapper) return;
		const input =
			wrapper.querySelector(".password-input") ||
			wrapper.querySelector('input[type="password"], input[type="text"]');
		if (!input) return;
		btn.addEventListener("click", () => {
			const isHidden = input.type === "password";
			input.type = isHidden ? "text" : "password";
			const eyeOpen = btn.querySelector(".eye-open");
			const eyeClosed = btn.querySelector(".eye-closed");
			if (eyeOpen && eyeClosed) {
				eyeOpen.style.display = isHidden ? "" : "none";
				eyeClosed.style.display = isHidden ? "none" : "";
			}
			btn.setAttribute(
				"aria-label",
				isHidden ? "Hide password" : "Show password",
			);
		});
	});

	// ─── Login form ───────────────────────────────────────────────────────────
	if (loginForm) {
		let loggingIn = false;
		loginForm.addEventListener("submit", async function (e) {
			e.preventDefault();
			if (loggingIn) return;
			let valid = true;

			if (!loginUsername.value.trim()) {
				showError(loginUsername, "Please enter your email or username.");
				valid = false;
			} else {
				clearError(loginUsername);
			}

			if (!isValidPassword(loginPassword.value)) {
				showError(
					loginPassword,
					"Password must be at least 8 characters.",
				);
				valid = false;
			} else {
				clearError(loginPassword);
			}

			if (!valid) return;

			showLoginNotice("");
			loggingIn = true;
			setFormControlsDisabled(loginForm, true);
			try {
				const { ok, data } = await loginUser(
					loginUsername.value.trim(),
					loginPassword.value,
				);

				if (!ok) {
					loggingIn = false;
					setFormControlsDisabled(loginForm, false);
					showError(
						loginUsername,
						data.error || "Invalid credentials",
					);
					return;
				}

				// Store the username only after authentication succeeds.
				if (rememberUser?.checked) {
					localStorage.setItem("rememberedUser", loginUsername.value.trim());
				} else {
					localStorage.removeItem("rememberedUser");
				}

				// Server sets HttpOnly cookie for auth; persist only non-sensitive user info.
				// Store a minimal, sanitized user object in localStorage (no tokens)
				const safeUser = {
					id: data.user?.id,
					name: data.user?.name || "",
					username: data.user?.username || "",
					nickname: data.user?.username || "",
					profilePics: data.user?.profilePics || [],
					bio: data.user?.bio || "",
					email: data.user?.email || "",
				};
				localStorage.setItem("user", JSON.stringify(safeUser));
				// replace(): "back" from the chat must not return to this form
				window.location.replace("/chat/");
			} catch {
				loggingIn = false;
				setFormControlsDisabled(loginForm, false);
				showError(loginUsername, "Connection error");
			}
		});

		if (forgetPasswordBtn) {
			forgetPasswordBtn.addEventListener("click", (e) => {
				e.preventDefault();
				showForm(allForms, forgotForm);
				setFormControlsDisabled(forgotForm, false);
				if (forgotInput && !forgotInput.value && loginUsername?.value)
					forgotInput.value = loginUsername.value.trim();
			});
		}

		if (showSignUp) {
			showSignUp.addEventListener("click", () => {
				showForm(allForms, signupForm);
				// reset signup form state when revealing the signup form
				setFormControlsDisabled(signupForm, false);
			});
		}
	}

	// ─── Sign up form ─────────────────────────────────────────────────────────
	if (signupForm) {
		signupForm.addEventListener("submit", async (e) => {
			e.preventDefault();
			// disable entire signup form immediately to prevent double-clicks
			setFormControlsDisabled(signupForm, true);
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
					"Username must be 3-30 characters, letters, numbers, or underscores only.",
				);
				valid = false;
			} else {
				clearError(signupUsername);
			}

			if (!valid) {
				setFormControlsDisabled(signupForm, false);
				return;
			}

			// A taken email or username is reported now, not after the code
			try {
				const { ok, data } = await checkAvailability(
					signupEmail.value.trim(),
					signupUsername.value.trim(),
				);
				if (ok && (data.emailTaken || data.usernameTaken)) {
					if (data.emailTaken) showError(signupEmail, "This email is already taken.");
					if (data.usernameTaken) showError(signupUsername, "This username is already taken.");
					setFormControlsDisabled(signupForm, false);
					return;
				}
			} catch (err) {
				/* the server checks again when the account is created */
			}

			forgotPass = false;
			clearCodeInputs(verifyForm);
			try {
				await sendCode(signupEmail.value.trim());
				_verificationEmail = signupEmail.value.trim();
			} catch (err) {
				showError(signupEmail, err.message || 'Failed to send code');
				// re-enable entire form so user can retry
				setFormControlsDisabled(signupForm, false);
				return;
			}
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

		verifyForm.addEventListener("submit", async function (e) {
			e.preventDefault();
			const code = Array.from(codeDigits)
				.map((i) => i.value || "")
				.join("");

			if (code.length < codeDigits.length) {
				const target =
					codeDigits[0] ||
					codeHidden ||
					verifyForm.querySelector("input");
				if (target) {
					showError(target, "Please enter the full 6-digit code.");
					if (typeof target.focus === "function") target.focus();
				}
				return;
			}

			if (codeHidden) codeHidden.value = code;

			try {
				const res = await fetch('/api/auth/verify-code', {
					method: 'POST',
					credentials: 'include',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ email: _verificationEmail, code }),
				});
				if (!res.ok) {
					const err = await res.json().catch(() => ({}));
					const target = codeDigits[0] || codeHidden || verifyForm.querySelector('input');
					if (target) {
						showError(target, err.error || 'The code is incorrect. Please try again.');
						clearCodeInputs(verifyForm);
						if (typeof target.focus === 'function') target.focus();
					}
					return;
				}
				// Verified successfully
				clearCodeInputs(verifyForm);
				showForm(allForms, passwordForm);
				if (passwordInput) passwordInput.focus();
			} catch (err) {
				showError(codeDigits[0] || codeHidden || verifyForm.querySelector('input'), 'Connection error');
			}
		});

		if (codeResendTimer) {
			codeResendTimer.addEventListener("click", async () => {
				if (codeResendTimer.classList.contains("disabled")) return;
					clearCodeInputs(verifyForm);

				// Prefer the stored verification email; fall back to visible inputs.
				const candidate = _verificationEmail || (forgotInput && forgotInput.value && forgotInput.value.trim()) || (signupEmail && signupEmail.value && signupEmail.value.trim());
						const target = verifyForm ? (verifyForm.querySelector('.code-digit') || verifyForm.querySelector('input')) : null;
						// Clear any existing verification error when user explicitly resends the code
						if (target) clearError(target);

				if (!candidate) {
					if (target) showError(target, 'No email available to resend the code');
					return;
				}

				try {
					await sendCode(candidate);
					// Update stored email in case it was missing
					_verificationEmail = candidate;
					startResendTimer(codeResendTimer);
				} catch (err) {
					if (target) showError(target, err.message || 'Failed to resend code');
				}
			});
		}

		if (backToSignUp) {
			backToSignUp.addEventListener("click", () => {
				clearResendTimer();
				if (forgotPass) {
					showForm(allForms, forgotForm);
				} else {
					showForm(allForms, signupForm);
					// ensure signup form enabled when returning
					setFormControlsDisabled(signupForm, false);
				}
			});
		}
	}

	// ─── Password form ────────────────────────────────────────────────────────
	if (passwordForm) {
		passwordForm.addEventListener("submit", async function (e) {
			e.preventDefault();
			let valid = true;

			if (!isValidPassword(passwordInput.value)) {
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

			// (forgotten passwords are reset from the emailed link, so this
			// form only finishes signing up)
			setFormControlsDisabled(passwordForm, true);
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

				const newUsername = signupUsername.value.trim();
				passwordInput.value = "";
				confirmPasswordInput.value = "";
				signupForm.reset();
				setFormControlsDisabled(signupForm, false);
				showForm(allForms, loginForm);
				if (loginUsername) loginUsername.value = newUsername;
				if (loginPassword) {
					loginPassword.value = "";
					loginPassword.focus();
				}
				showLoginNotice("Your account is ready. Sign in with your new password.");
			} catch {
				showError(passwordInput, "Connection error");
			} finally {
				setFormControlsDisabled(passwordForm, false);
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
		forgotForm.addEventListener("submit", async function (e) {
			e.preventDefault();

			const val = (forgotInput.value || '').trim();
			if (!isValidEmail(val) && !isValidUsername(val)) {
				showError(forgotInput, "Please enter a valid email or username.");
				return;
			}
			clearError(forgotInput);

			// Disable controls to prevent repeat submits (same style as signup)
			setFormControlsDisabled(forgotForm, true);

			forgotPass = true;
			clearCodeInputs(verifyForm);
			try {
				const { ok, data } = await requestPasswordReset(val);
				if (!ok) {
					showError(forgotInput, data.error || 'Failed to request password reset');
					setFormControlsDisabled(forgotForm, false);
					return;
				}
				// ready for another request later
				setFormControlsDisabled(forgotForm, false);
				showForm(allForms, loginForm);
				clearError(loginUsername);
				showLoginNotice('If the account exists, a password reset link is on its way to its email.');
			} catch (err) {
				showError(forgotInput, err.message || 'Failed to request password reset');
				setFormControlsDisabled(forgotForm, false);
				return;
			}
		});

		if (backToLogin2) {
			backToLogin2.addEventListener("click", () => {
				showForm(allForms, loginForm);
			});
		}
	}

	// prevent pinch zoom and double tap zoom on mobile devices for better UX
	document.addEventListener(
		"touchmove",
		function (e) {
			if (e.touches.length > 1) e.preventDefault();
		},
		{ passive: false },
	);
	document.addEventListener(
		"gesturestart",
		function (e) {
			e.preventDefault();
		},
		{ passive: false },
	);
	document.addEventListener(
		"gesturechange",
		function (e) {
			e.preventDefault();
		},
		{ passive: false },
	);

	document.addEventListener(
		"gestureend",
		function (e) {
			e.preventDefault();
		},
		{ passive: false },
	);
	// Double-tap zoom is turned off in CSS (touch-action: manipulation): a
	// touchend blocker here used to swallow quick second taps on buttons.
});
