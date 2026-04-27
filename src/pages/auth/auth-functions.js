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

	let sentCode = null;
	let forgotPass = false;
	let resendTimerInterval = null;

	// ─── Helpers ──────────────────────────────────────────────────────────────
	function showForm(targetForm) {
		allForms.forEach((f) => (f.style.display = "none"));
		if (targetForm) targetForm.style.display = "flex";
	}

	function showError(input, message) {
		clearError(input);
		input.style.borderColor = "#e05c5c";
		const err = document.createElement("span");
		err.className = "input-error";
		err.textContent = message;
		err.style.cssText =
			"color:#e05c5c;font-size:0.75rem;margin-top:-0.5rem;display:block;";
		input.insertAdjacentElement("afterend", err);
	}

	function clearError(input) {
		input.style.borderColor = "";
		const next = input.nextElementSibling;
		if (next && next.classList.contains("input-error")) next.remove();
	}

	function isValidEmail(email) {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
	}

	function isValidUsername(username) {
		return /^[a-zA-Z0-9_]{3,20}$/.test(username);
	}

	function sendCode() {
		sentCode = Math.floor(Math.random() * 900000 + 100000);
		// وقتی بکند داشتی اینجا ایمیل میفرستی
		// فعلاً برای تست توی alert نشون میده
		alert(`Your verification code is: ${sentCode}`);
	}

	function startResendTimer() {
		if (resendTimerInterval) clearInterval(resendTimerInterval);
		let sec = 60;
		codeResendTimer.classList.add("disabled");
		codeResendTimer.style.pointerEvents = "none";
		codeResendTimer.style.opacity = "0.5";

		resendTimerInterval = setInterval(function () {
			if (sec === 0) {
				clearInterval(resendTimerInterval);
				resendTimerInterval = null;
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

	function clearCodeInputs() {
		if (!verifyForm) return;
		verifyForm
			.querySelectorAll(".code-digit")
			.forEach((d) => (d.value = ""));
	}

	// ─── Auto-fill remembered user ────────────────────────────────────────────
	const remembered = localStorage.getItem("rememberedUser");
	if (remembered && loginUsername) {
		loginUsername.value = remembered;
		if (rememberUser) rememberUser.checked = true;
	}

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
				const res = await fetch("/api/auth/login", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						identifier: loginUsername.value.trim(),
						password: loginPassword.value,
					}),
				});

				const data = await res.json();

				if (!res.ok) {
					showError(
						loginUsername,
						data.error || "Invalid credentials",
					);
					return;
				}

				sessionStorage.setItem("token", data.token);
				sessionStorage.setItem("user", JSON.stringify(data.user));
				window.location.href = "../main/main-page.html";
			} catch {
				showError(loginUsername, "Connection error");
			}
		});

		if (forgetPasswordBtn) {
			forgetPasswordBtn.addEventListener("click", () => {
				showForm(forgotForm);
			});
		}

		if (showSignUp) {
			showSignUp.addEventListener("click", () => {
				showForm(signupForm);
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
			clearCodeInputs();
			sendCode();
			startResendTimer();
			showForm(verifyForm);
			const firstDigit = verifyForm.querySelector(".code-digit");
			if (firstDigit) firstDigit.focus();
		});

		if (showLogIn) {
			showLogIn.addEventListener("click", () => {
				showForm(loginForm);
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

			if (String(sentCode) === code) {
				clearCodeInputs();
				showForm(passwordForm);
				if (passwordInput) passwordInput.focus();
			} else {
				alert("The code entered does not match. Please try again.");
				clearCodeInputs();
				codeDigits[0].focus();
			}
		});

		if (codeResendTimer) {
			codeResendTimer.addEventListener("click", () => {
				if (codeResendTimer.classList.contains("disabled")) return;
				clearCodeInputs();
				sendCode();
				startResendTimer();
			});
		}

		if (backToSignUp) {
			backToSignUp.addEventListener("click", () => {
				if (resendTimerInterval) {
					clearInterval(resendTimerInterval);
					resendTimerInterval = null;
				}
				forgotPass ? showForm(forgotForm) : showForm(signupForm);
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
				// reset password flow
				showForm(loginForm);
				alert("Password reset successfully. Please log in.");
			} else {
				try {
					const res = await fetch("/api/auth/register", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							name: signupName.value.trim(),
							email: signupEmail.value.trim(),
							username: signupUsername.value.trim(),
							password: passwordInput.value,
						}),
					});

					const data = await res.json();

					if (!res.ok) {
						showError(
							passwordInput,
							data.error || "Registration failed",
						);
						return;
					}

					showForm(loginForm);
					alert("Account created! Please log in.");
				} catch {
					showError(passwordInput, "Connection error");
				}
			}
		});

		if (backToLogin) {
			backToLogin.addEventListener("click", () => {
				showForm(loginForm);
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
			clearCodeInputs();
			sendCode();
			startResendTimer();
			showForm(verifyForm);
			const firstDigit = verifyForm?.querySelector(".code-digit");
			if (firstDigit) firstDigit.focus();
		});

		if (backToLogin2) {
			backToLogin2.addEventListener("click", () => {
				showForm(loginForm);
			});
		}
	}
});
