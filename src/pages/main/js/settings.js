import { updatePrivacy, deleteAccount } from "./api.js";
import { showToast } from "./ui.js";

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
		});
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
					sessionStorage.clear();
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

	function closeAll() {
		pickers.forEach((p) => {
			if (p.picker) p.picker.style.display = "none";
			if (p.picker)
				p.picker
					.querySelectorAll(".settings-picker-option")
					.forEach((o) => o.classList.remove("active"));
		});
	}

	pickers.forEach((p) => {
		if (!p.row || !p.picker) return;
		p.row.addEventListener("click", (e) => {
			e.stopPropagation();
			const isOpen = p.picker.style.display === "block";
			closeAll();
			if (!isOpen) {
				p.picker.style.display = "block";
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
							sessionStorage.getItem("user") || "{}",
						);
						sessionStorage.setItem(
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
		if (!inside) closeAll();
	});

	// Archived/Blocked
	if (_dom.settingsArchived)
		_dom.settingsArchived.addEventListener("click", () =>
			showToast("Coming soon"),
		);
	if (_dom.settingsBlocked)
		_dom.settingsBlocked.addEventListener("click", () =>
			showToast("Coming soon"),
		);

	// Apply theme on init
	const theme = localStorage.getItem("rivo-theme") || "light";
	if (theme === "dark") document.body.classList.add("dark-mode");
	else document.body.classList.remove("dark-mode");
	if (_dom.settingsThemeValue)
		_dom.settingsThemeValue.textContent =
			theme === "dark" ? "Dark" : "Light";
}

export function openSettings(user) {
    _currentUser = user || _currentUser;
    if (!_currentUser) _currentUser = JSON.parse(sessionStorage.getItem('user') || '{}');

    // populate privacy values
    try {
        if (_dom.settingsPrivacyOnline) _dom.settingsPrivacyOnline.querySelector('.settings-row-value').textContent = _format(_currentUser.privacyOnline);
        if (_dom.settingsPrivacyEmail) _dom.settingsPrivacyEmail.querySelector('.settings-row-value').textContent = _format(_currentUser.privacyEmail);
        if (_dom.settingsPrivacyProfile) _dom.settingsPrivacyProfile.querySelector('.settings-row-value').textContent = _format(_currentUser.privacyProfile);
    } catch (e) { /* ignore */ }

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
