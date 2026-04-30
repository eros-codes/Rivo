import { updateMe, uploadAvatar, deleteAvatar } from "./api.js";
let _dom = {};
let _currentUser = null;
let _cropper = null;

/**
 * @param {{
 *   editProfilePanel, editProfileDialog,
 *   editProfileClose, editProfileSave,
 *   editNameInput, editUsernameInput, editBioInput,
 *   editProfileAvatar, avatarBtn, avatarFileInput, deleteAvatarBtn,
 *   avatarCropDialog, avatarCropImage,
 *   avatarCropCancel, avatarCropConfirm,
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

	_dom.avatarBtn.addEventListener("click", () => {
		_dom.avatarFileInput.click();
	});

	_dom.avatarFileInput.addEventListener("change", (e) => {
		const file = e.target.files[0];
		if (!file) return;
		const url = URL.createObjectURL(file);
		_dom.avatarCropImage.src = url;
		_dom.avatarCropDialog.showModal();

		if (_cropper) {
			_cropper.destroy();
			_cropper = null;
		}

		_dom.avatarCropImage.onload = () => {
			_cropper = new Cropper(_dom.avatarCropImage, {
				aspectRatio: 1,
				viewMode: 2,
				dragMode: "move",
			});
		};
	});

	_dom.avatarCropCancel.addEventListener("click", () => {
		_dom.avatarCropDialog.close();
		if (_cropper) {
			_cropper.destroy();
			_cropper = null;
		}
		_dom.avatarFileInput.value = "";
	});

	_dom.avatarCropConfirm.addEventListener("click", async () => {
		if (!_cropper) return;
		_cropper.getCroppedCanvas({ width: 400, height: 400 }).toBlob(
			async (blob) => {
				const formData = new FormData();
				formData.append("avatar", blob, "avatar.jpg");
				const res = await uploadAvatar(formData);
				if (res.url) {
					_dom.editProfileAvatar.src = res.url + "?t=" + Date.now();
					if (_currentUser) _currentUser.profilePics = [res.url];
					const stored = JSON.parse(
						localStorage.getItem("user") || "{}",
					);
					localStorage.setItem(
						"user",
						JSON.stringify({ ...stored, profilePics: [res.url] }),
					);
				}
				_dom.avatarCropDialog.close();
				if (_cropper) {
					_cropper.destroy();
					_cropper = null;
				}
				_dom.avatarFileInput.value = "";
			},
			"image/jpeg",
			0.9,
		);
	});

	_dom.deleteAvatarBtn.addEventListener("click", async () => {
		await deleteAvatar();
		_dom.editProfileAvatar.src = "";
		if (_currentUser) _currentUser.profilePics = [];
		const stored = JSON.parse(localStorage.getItem("user") || "{}");
		localStorage.setItem(
			"user",
			JSON.stringify({ ...stored, profilePics: [] }),
		);
	});
}

export function openEditProfile(user) {
	_currentUser = user;
	_dom.editNameInput.value = user.name || "";
	_dom.editUsernameInput.value = user.username || "";
	_dom.editBioInput.value = user.bio || "";
	if (_dom.editProfileAvatar) {
		_dom.editProfileAvatar.src =
			user.profilePics?.[0] ||
			"../../../../public/assets/images/profile.jpeg";
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

async function _handleSave() {
	const name = _dom.editNameInput.value.trim();
	const username = _dom.editUsernameInput.value.trim();
	const bio = _dom.editBioInput.value.trim();

	if (!name) {
		_dom.editNameInput.focus();
		return;
	}

	try {
		const updated = await updateMe({ name, username, bio });

		if (_currentUser) {
			_currentUser.name = updated.name;
			_currentUser.username = updated.username;
			_currentUser.bio = updated.bio;
		}

		// session رو هم آپدیت کن
		const stored = JSON.parse(localStorage.getItem("user") || "{}");
		localStorage.setItem(
			"user",
			JSON.stringify({ ...stored, ...updated }),
		);

		closeEditProfile();
	} catch {
		console.error("Failed to update profile");
	}
}
