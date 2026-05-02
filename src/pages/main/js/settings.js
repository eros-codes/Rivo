import { updatePrivacy, deleteAccount, changePassword, logout } from "./api.js";
import { showToast } from "./ui.js";
import { applyAccentColor, applyWallpaper } from "../../../utils/theme.js";

let _dom = {};
let _currentUser = null;

function _format(v) {
    if (!v) return "Everyone";
    return v.charAt(0).toUpperCase() + v.slice(1);
}

export function initSettings(dom, currentUser) {
	_dom = dom;
	_currentUser = currentUser;

	if (_dom.settingsPanelClose)
		_dom.settingsPanelClose.addEventListener("click", closeSettings);
	if (_dom.settingsDialog) {
		_dom.settingsDialog.addEventListener("click", (e) => {
			if (e.target === _dom.settingsDialog) closeSettings();
		});
	}

	// Theme
	if (_dom.settingsThemeRow) {
		_dom.settingsThemeRow.addEventListener("click", () => {
			const current = localStorage.getItem("rivo-theme") || "light";
			const next = current === "light" ? "dark" : "light";
			localStorage.setItem("rivo-theme", next);
			if (next === "dark") document.body.classList.add("dark-mode");
			else document.body.classList.remove("dark-mode");
			_dom.settingsThemeValue.textContent =
				next === "dark" ? "Dark" : "Light";

			const accent = localStorage.getItem("rivo-accent") || "#fa5f1a";
			applyAccentColor(accent);
		});
	}

	// Accent color
	if (_dom.settingsAccentRow && _dom.settingsAccentPanel) {
		_dom.settingsAccentRow.addEventListener("click", (e) => {
			e.stopPropagation();
			const isOpen = _dom.settingsAccentPanel.classList.contains("open");
			closeAll();
			if (!isOpen) {
				_dom.settingsAccentPanel.style.display = "block";
				requestAnimationFrame(() =>
					_dom.settingsAccentPanel.classList.add("open"),
				);
			}
		});

		_dom.settingsAccentPanel
			.querySelectorAll(".accent-swatch")
			.forEach((swatch) => {
				swatch.addEventListener("click", (e) => {
					e.stopPropagation();
					const color = swatch.dataset.color;
					_applyAndSaveAccent(color);
				});
			});

		const customBtn = document.getElementById("settings-accent-custom");
		if (customBtn && _dom.settingsAccentPicker) {
			customBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				_dom.settingsAccentPicker.click();
			});
			_dom.settingsAccentPicker.addEventListener("input", (e) => {
				e.stopPropagation();
				_applyAndSaveAccent(e.target.value);
			});
			_dom.settingsAccentPicker.addEventListener("click", (e) =>
				e.stopPropagation(),
			);
		}
	}

	// Wallpaper
	if (_dom.settingsWallpaperRow && _dom.settingsWallpaperPanel) {
		_dom.settingsWallpaperRow.addEventListener("click", (e) => {
			e.stopPropagation();
			const isOpen =
				_dom.settingsWallpaperPanel.classList.contains("open");
			closeAll();
			if (!isOpen) {
				_dom.settingsWallpaperPanel.style.display = "block";
				requestAnimationFrame(() =>
					_dom.settingsWallpaperPanel.classList.add("open"),
				);
			}
		});

		if (_dom.settingsWallpaperUpload) {
			_dom.settingsWallpaperUpload.addEventListener("click", (e) => {
				e.stopPropagation();
				_dom.settingsWallpaperInput?.click();
			});
		}

		if (_dom.settingsWallpaperInput) {
			_dom.settingsWallpaperInput.addEventListener("change", (e) => {
				const file = e.target.files?.[0];
				if (!file) return;
				const reader = new FileReader();
				reader.onload = (ev) => {
					const base64 = ev.target.result;
					localStorage.setItem("rivo-wallpaper", base64);
					applyWallpaper(base64);
					if (_dom.settingsWallpaperValue)
						_dom.settingsWallpaperValue.textContent = "Custom";
					showToast("Background updated");
				};
				reader.readAsDataURL(file);
			});
		}

		if (_dom.settingsWallpaperRemove) {
			_dom.settingsWallpaperRemove.addEventListener("click", (e) => {
				e.stopPropagation();
				localStorage.removeItem("rivo-wallpaper");
				applyWallpaper(null);
				if (_dom.settingsWallpaperValue)
					_dom.settingsWallpaperValue.textContent = "Default";
				showToast("Background removed");
			});
		}
	}

	// Delete account
	if (_dom.settingsDeleteAccount) {
		_dom.settingsDeleteAccount.addEventListener("click", async () => {
			if (
				!confirm(
					"Are you sure you want to delete your account? This cannot be undone.",
				)
			)
				return;
			const password = prompt(
				"Enter your password to confirm account deletion:",
			);
			if (password === null) return;
			try {
				const res = await deleteAccount(password);
				if (res && res.success) {
					// remove only auth data, keep preferences like theme
					localStorage.removeItem("user");
					window.location.href = "../auth/auth.html";
				} else {
					showToast(res?.error || "Failed to delete account");
				}
			} catch (err) {
				console.error(err);
				showToast("Server error deleting account");
			}
		});
	}

	// Privacy pickers
	const pickers = [
		{
			row: _dom.settingsPrivacyOnline,
			picker: _dom.pickerOnline,
			field: "privacyOnline",
		},
		{
			row: _dom.settingsPrivacyEmail,
			picker: _dom.pickerEmail,
			field: "privacyEmail",
		},
		{
			row: _dom.settingsPrivacyProfile,
			picker: _dom.pickerProfile,
			field: "privacyProfile",
		},
	];

	function _applyAndSaveAccent(color) {
		applyAccentColor(color);
		localStorage.setItem("rivo-accent", color);
		if (_dom.settingsAccentValue) {
			_dom.settingsAccentValue.style.background = color;
			_dom.settingsAccentValue.style.width = "16px";
			_dom.settingsAccentValue.style.height = "16px";
			_dom.settingsAccentValue.style.borderRadius = "50%";
			_dom.settingsAccentValue.textContent = "";
		}
		// active swatch highlight
		_dom.settingsAccentPanel
			?.querySelectorAll(".accent-swatch")
			.forEach((s) => {
				s.classList.toggle("active", s.dataset.color === color);
			});
	}

	function closeAll() {
		// close pickers with animation when open
		pickers.forEach((p) => {
			if (!p.picker) return;
			const el = p.picker;
			if (el.classList.contains("open")) {
				el.classList.remove("open");
				const onEnd = function () {
					if (!el.classList.contains("open"))
						el.style.display = "none";
					el.removeEventListener("transitionend", onEnd);
				};
				el.addEventListener("transitionend", onEnd);
			} else {
				el.style.display = "none";
			}
			el.querySelectorAll(".settings-picker-option").forEach((o) =>
				o.classList.remove("active"),
			);
		});

		// gracefully close the change-password form using CSS transitions
		if (_dom.settingsChangePasswordForm) {
			const el = _dom.settingsChangePasswordForm;
			if (el.classList.contains("open")) {
				el.classList.remove("open");
				const onEnd = function () {
					if (!el.classList.contains("open"))
						el.style.display = "none";
					el.removeEventListener("transitionend", onEnd);
				};
				el.addEventListener("transitionend", onEnd);
			} else {
				el.style.display = "none";
			}
		}

		// clear password fields when closing any interactive element
		if (_dom.settingsCurrentPassword)
			_dom.settingsCurrentPassword.value = "";
		if (_dom.settingsNewPassword) _dom.settingsNewPassword.value = "";
		if (_dom.settingsConfirmPassword)
			_dom.settingsConfirmPassword.value = "";

		// close accent/wallpaper panels without animation since they don't have transition styles
		if (_dom.settingsAccentPanel) {
			_dom.settingsAccentPanel.classList.remove("open");
			_dom.settingsAccentPanel.style.display = "none";
		}
		if (_dom.settingsWallpaperPanel) {
			_dom.settingsWallpaperPanel.classList.remove("open");
			_dom.settingsWallpaperPanel.style.display = "none";
		}
	}

	pickers.forEach((p) => {
		if (!p.row || !p.picker) return;
		p.row.addEventListener("click", (e) => {
			e.stopPropagation();
			if (!p.picker) return;
			const isOpen = p.picker.classList.contains("open");
			closeAll();
			if (!isOpen) {
				p.picker.style.display = "block";
				// animate open
				requestAnimationFrame(() => p.picker.classList.add("open"));
				const cur =
					(_currentUser && _currentUser[p.field]) || "everyone";
				p.picker
					.querySelectorAll(".settings-picker-option")
					.forEach((o) =>
						o.classList.toggle("active", o.dataset.value === cur),
					);
			}
		});

		p.picker.querySelectorAll(".settings-picker-option").forEach((opt) => {
			opt.addEventListener("click", async (e) => {
				const val = opt.dataset.value;
				// update UI immediately
				const text = _format(val);
				const valueEl = p.row.querySelector(".settings-row-value");
				if (valueEl) valueEl.textContent = text;
				closeAll();
				try {
					const res = await updatePrivacy({ [p.field]: val });
					if (res && res.error) {
						showToast(res.error);
					} else {
						if (_currentUser) _currentUser[p.field] = val;
						const stored = JSON.parse(
							localStorage.getItem("user") || "{}",
						);
						localStorage.setItem(
							"user",
							JSON.stringify({ ...stored, ...(res || {}) }),
						);
						showToast("Saved");
					}
				} catch (err) {
					console.error(err);
					showToast("Server error");
				}
			});
		});
	});

	document.addEventListener("click", (e) => {
		const inside = pickers.some(
			(p) =>
				(p.picker && p.picker.contains(e.target)) ||
				(p.row && p.row.contains(e.target)),
		);
		// also treat change-password elements as interactive
		const changeOpen =
			_dom.settingsChangePassword &&
			_dom.settingsChangePassword.contains(e.target);
		const changeFormInside =
			_dom.settingsChangePasswordForm &&
			_dom.settingsChangePasswordForm.contains(e.target);
		if (!inside && !changeOpen && !changeFormInside) closeAll();
	});

	// Change password toggle + submit
	if (_dom.settingsChangePassword && _dom.settingsChangePasswordForm) {
		_dom.settingsChangePassword.addEventListener("click", (e) => {
			e.stopPropagation();
			const form = _dom.settingsChangePasswordForm;
			const isOpen = form.classList.contains("open");
			closeAll();
			if (!isOpen) {
				// show then animate open
				form.style.display = "block";
				requestAnimationFrame(() => form.classList.add("open"));
			} else {
				form.classList.remove("open");
				const onEnd = function () {
					if (!form.classList.contains("open"))
						form.style.display = "none";
					form.removeEventListener("transitionend", onEnd);
				};
				form.addEventListener("transitionend", onEnd);
			}
		});

		// password-toggle buttons inside the form
		_dom.settingsChangePasswordForm
			.querySelectorAll(".password-toggle")
			.forEach((btn) => {
				btn.addEventListener("click", (ev) => {
					ev.preventDefault();
					const wrapper = btn.closest(".password-wrapper");
					if (!wrapper) return;
					const input = wrapper.querySelector("input");
					if (!input) return;
					if (input.type === "password") {
						input.type = "text";
						btn.querySelector(".eye-open").style.display = "";
						btn.querySelector(".eye-closed").style.display = "none";
					} else {
						input.type = "password";
						btn.querySelector(".eye-open").style.display = "none";
						btn.querySelector(".eye-closed").style.display = "";
					}
				});
			});

		// submit handler
		const submitBtn = _dom.settingsChangePasswordSubmit;
		if (submitBtn) {
			submitBtn.addEventListener("click", async () => {
				const cur =
					(_dom.settingsCurrentPassword &&
						_dom.settingsCurrentPassword.value) ||
					"";
				const nw =
					(_dom.settingsNewPassword &&
						_dom.settingsNewPassword.value) ||
					"";
				const conf =
					(_dom.settingsConfirmPassword &&
						_dom.settingsConfirmPassword.value) ||
					"";
				if (!cur.trim()) {
					showToast("Enter current password");
					return;
				}
				if (nw.length < 8) {
					showToast("New password must be at least 8 characters");
					return;
				}
				if (nw !== conf) {
					showToast("Passwords do not match");
					return;
				}
				submitBtn.disabled = true;
				try {
					const res = await changePassword(cur, nw);
					if (res && res.success) {
						showToast("Password changed. Please log in again.");
						try {
							await logout();
						} catch (e) {
							// ignore logout errors, continue to clear local state
						}
						localStorage.removeItem("user");
						window.location.href = "../auth/auth.html";
					} else {
						showToast(res?.error || "Failed to change password");
					}
				} catch (err) {
					console.error(err);
					showToast("Server error");
				} finally {
					submitBtn.disabled = false;
				}
			});
		}
	}

	// Archived
	if (_dom.settingsArchived)
		_dom.settingsArchived.addEventListener("click", () =>
			showToast("Coming soon"),
		);

	// Apply theme on init
	const theme = localStorage.getItem("rivo-theme") || "light";
	if (_dom.settingsThemeValue)
		_dom.settingsThemeValue.textContent =
			theme === "dark" ? "Dark" : "Light";
}

export function openSettings(user) {
	_currentUser = user || _currentUser;
	if (!_currentUser) _currentUser = JSON.parse(localStorage.getItem('user') || '{}');

    // populate privacy values
    try {
        if (_dom.settingsPrivacyOnline) _dom.settingsPrivacyOnline.querySelector('.settings-row-value').textContent = _format(_currentUser.privacyOnline);
        if (_dom.settingsPrivacyEmail) _dom.settingsPrivacyEmail.querySelector('.settings-row-value').textContent = _format(_currentUser.privacyEmail);
        if (_dom.settingsPrivacyProfile) _dom.settingsPrivacyProfile.querySelector('.settings-row-value').textContent = _format(_currentUser.privacyProfile);
    } catch (e) { /* ignore */ }

	// populate accent color
	const savedAccent = localStorage.getItem("rivo-accent") || "#fa5f1a";
	if (_dom.settingsAccentValue) {
		_dom.settingsAccentValue.style.background = savedAccent;
		_dom.settingsAccentValue.style.width = "16px";
		_dom.settingsAccentValue.style.height = "16px";
		_dom.settingsAccentValue.style.borderRadius = "50%";
	}
	if (_dom.settingsAccentPicker)
		_dom.settingsAccentPicker.value = savedAccent;
	_dom.settingsAccentPanel
		?.querySelectorAll(".accent-swatch")
		.forEach((s) => {
			s.classList.toggle("active", s.dataset.color === savedAccent);
		});

	const savedWallpaper = localStorage.getItem("rivo-wallpaper");
	if (_dom.settingsWallpaperValue)
		_dom.settingsWallpaperValue.textContent = savedWallpaper
			? "Custom"
			: "Default";

    if (window.innerWidth > 700) {
        if (!_dom.settingsDialog) {
            const d = document.createElement('dialog');
            d.className = 'settings-dialog';
            d.addEventListener('click', (e) => {
                if (e.target === d) closeSettings();
            });
            document.body.appendChild(d);
            _dom.settingsDialog = d;
        }
        _dom.settingsDialog.appendChild(_dom.settingsPanel);
        _dom.settingsDialog.showModal();
    } else {
        _dom.settingsPanel.style.display = 'flex';
        _dom.settingsPanel.classList.remove('slide-out');
        _dom.settingsPanel.classList.add('slide-in');
        _dom.settingsPanel.addEventListener('animationend', () => {
            _dom.settingsPanel.classList.remove('slide-in');
        }, { once: true });
    }
}

export function closeSettings() {
    if (window.innerWidth > 700) {
        _dom.settingsDialog.close();
        _dom.settingsDialog.innerHTML = '';
    } else {
        _dom.settingsPanel.classList.remove('slide-in');
        _dom.settingsPanel.classList.add('slide-out');
        _dom.settingsPanel.addEventListener('animationend', () => {
            _dom.settingsPanel.classList.remove('slide-out');
            _dom.settingsPanel.style.display = 'none';
        }, { once: true });
    }
}
