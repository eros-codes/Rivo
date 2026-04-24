let _dom = {};
let _currentUser = null;

/**
 * @param {{
 *   editProfilePanel, editProfileDialog,
 *   editProfileClose, editProfileSave,
 *   editNameInput, editUsernameInput, editBioInput,
 *   editProfileAvatar,
 *   chatPart, peoplePart
 * }} dom
 */
export function initEditProfile(dom) {
	_dom = dom;

	_dom.editProfileClose.addEventListener("click", closeEditProfile);

	_dom.editProfileDialog.addEventListener("click", (e) => {
		if (e.target === _dom.editProfileDialog) closeEditProfile();
	});

	_dom.editProfileSave.addEventListener("click", _handleSave);
}

export function openEditProfile(user) {
	_currentUser = user;
	_dom.editNameInput.value = user.name || "";
	_dom.editUsernameInput.value = user.username || "";
	_dom.editBioInput.value = user.bio || "";
	if (_dom.editProfileAvatar) {
		_dom.editProfileAvatar.src = user.profilePics?.[0] || "";
	}

	if (window.innerWidth > 700) {
		_dom.editProfileDialog.appendChild(_dom.editProfilePanel);
		_dom.editProfileDialog.showModal();
	} else {
		_dom.editProfilePanel.style.display = "flex";
		_dom.editProfilePanel.classList.remove("slide-out");
		_dom.editProfilePanel.classList.add("slide-in");
		_dom.editProfilePanel.addEventListener(
			"animationend",
			() => {
				_dom.editProfilePanel.classList.remove("slide-in");
			},
			{ once: true },
		);
	}
}

export function closeEditProfile() {
	if (window.innerWidth > 700) {
		_dom.editProfileDialog.close();
		_dom.editProfileDialog.innerHTML = "";
	} else {
		_dom.editProfilePanel.classList.remove("slide-in");
		_dom.editProfilePanel.classList.add("slide-out");
		_dom.editProfilePanel.addEventListener(
			"animationend",
			() => {
				_dom.editProfilePanel.classList.remove("slide-out");
				_dom.editProfilePanel.style.display = "none";
			},
			{ once: true },
		);
	}
}

function _handleSave() {
	const name = _dom.editNameInput.value.trim();
	const username = _dom.editUsernameInput.value.trim();
	const bio = _dom.editBioInput.value.trim();

	if (!name) {
		_dom.editNameInput.focus();
		return;
	}

	// TODO: await apiUpdateProfile({ name, username, bio });
	if (_currentUser) {
		_currentUser.name = name;
		_currentUser.username = username;
		_currentUser.bio = bio;
	}

	closeEditProfile();
}
