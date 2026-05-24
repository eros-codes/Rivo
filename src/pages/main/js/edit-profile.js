/* global Cropper */
import { updateMe, uploadAvatar, deleteAvatar } from "./api.js";
import { safeSrc, mountAvatar, refreshUserAvatars } from "../../../utils/dom.js";
import { getCurrentUser } from "./currentUser.js";
import { isValidUsername } from "../../auth/js/auth-validate.js";
import { showToast } from "./ui.js";
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
				const wrapper = _dom.editProfileAvatar?.closest?.('.edit-profile-avatar-wrapper');
				if (wrapper) wrapper.classList.add('uploading');
				let res;
				try {
					res = await uploadAvatar(formData);
				} finally {
					if (wrapper) wrapper.classList.remove('uploading');
				}
				if (res && res.url) {
					// prefer mounting into the wrapper so we always replace the
					// current avatar element (handles cases where the img was
					// previously replaced by a div)
					const wrapper = (_dom.editProfileAvatar && _dom.editProfileAvatar.closest)
						? _dom.editProfileAvatar.closest('.edit-profile-avatar-wrapper')
						: document.querySelector('.edit-profile-avatar-wrapper');
					const target = wrapper || _dom.editProfileAvatar;
					mountAvatar(target, {
						name: _currentUser?.name || "",
						nickname: _currentUser?.username || "",
						profilePics: [res.url + "?t=" + Date.now()],
						className: 'edit-profile-avatar',
					});
					if (_currentUser) _currentUser.profilePics = [res.url];
					let stored = getCurrentUser() || {};
					const newStored = {
						id: stored.id || (_currentUser && _currentUser.id) || null,
						name: (_currentUser && _currentUser.name) || stored.name || "",
						username: (_currentUser && _currentUser.username) || stored.username || "",
						nickname: (_currentUser && (_currentUser.nickname || _currentUser.username)) || stored.nickname || "",
						profilePics: (_currentUser && _currentUser.profilePics) || [res.url] || stored.profilePics || [],
						isSaved: stored.isSaved || false,
						isOnline: stored.isOnline || false,
						conversationId: stored.conversationId || null,
						bio: (_currentUser && _currentUser.bio) || stored.bio || "",
						email: stored.email || "",
					};
					localStorage.setItem("user", JSON.stringify(newStored));
					_dom.avatarCropDialog.close();
					// update avatars across the UI immediately
					try { refreshUserAvatars(_currentUser); } catch (e) { /* ignore */ }
				} else {
					alert(res?.error || "Upload failed. Please try again.");
				}
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
		const wrapper = _dom.editProfileAvatar?.closest?.('.edit-profile-avatar-wrapper');
		if (wrapper) wrapper.classList.add('uploading');
		try {
			await deleteAvatar();
			// render initial-letter fallback
			const wrapperTarget = (_dom.editProfileAvatar && _dom.editProfileAvatar.closest)
				? _dom.editProfileAvatar.closest('.edit-profile-avatar-wrapper')
				: document.querySelector('.edit-profile-avatar-wrapper');
			const target = wrapperTarget || _dom.editProfileAvatar;
			mountAvatar(target, {
				name: _currentUser?.name || "",
				nickname: _currentUser?.username || "",
				profilePics: [],
				className: 'edit-profile-avatar',
			});
			if (_currentUser) _currentUser.profilePics = [];
			// update avatars across the UI immediately
			try { refreshUserAvatars(_currentUser); } catch (e) { /* ignore */ }
		} finally {
			if (wrapper) wrapper.classList.remove('uploading');
		}
		let stored = getCurrentUser() || {};
		const newStored = {
			id: stored.id || (_currentUser && _currentUser.id) || null,
			name: (_currentUser && _currentUser.name) || stored.name || "",
			username: (_currentUser && _currentUser.username) || stored.username || "",
			nickname: (_currentUser && (_currentUser.nickname || _currentUser.username)) || stored.nickname || "",
			profilePics: [],
			isSaved: stored.isSaved || false,
			isOnline: stored.isOnline || false,
			conversationId: stored.conversationId || null,
			bio: (_currentUser && _currentUser.bio) || stored.bio || "",
			email: stored.email || "",
		};
		localStorage.setItem("user", JSON.stringify(newStored));
	});
}

export function openEditProfile(user) {
	_currentUser = user;
	_dom.editNameInput.value = user.name || "";
	_dom.editUsernameInput.value = user.username || "";
	_dom.editBioInput.value = user.bio || "";
	if (_dom.editProfileAvatar) {
		const wrapperTarget = (_dom.editProfileAvatar && _dom.editProfileAvatar.closest)
			? _dom.editProfileAvatar.closest('.edit-profile-avatar-wrapper')
			: document.querySelector('.edit-profile-avatar-wrapper');
		const target = wrapperTarget || _dom.editProfileAvatar;
		mountAvatar(target, {
			name: user.name,
			nickname: user.username,
			profilePics: user.profilePics,
			className: 'edit-profile-avatar',
		});
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
		_dom.editProfileDialog.textContent = "";
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

	if (!name || name.length < 2) {
		showToast("Name must be at least 2 characters");
		_dom.editNameInput.focus();
		return;
	}

	if (username && !isValidUsername(username)) {
		showToast("Username must be 3-20 characters, letters, numbers, or underscores only.");
		_dom.editUsernameInput.focus();
		return;
	}

	try {
		const updated = await updateMe({ name, username, bio });

		if (_currentUser) {
			_currentUser.name = updated.name;
			_currentUser.username = updated.username;
			_currentUser.bio = updated.bio;
		}

		// update stored user (only allowed fields)
		let stored = getCurrentUser() || {};
		const newStored = {
			id: stored.id || (_currentUser && _currentUser.id) || null,
			name: updated.name || (_currentUser && _currentUser.name) || stored.name || "",
			username: updated.username || (_currentUser && _currentUser.username) || stored.username || "",
			nickname: updated.username || (_currentUser && (_currentUser.nickname || _currentUser.username)) || stored.nickname || "",
			profilePics: (_currentUser && _currentUser.profilePics) || stored.profilePics || [],
			isSaved: stored.isSaved || false,
			isOnline: stored.isOnline || false,
			conversationId: stored.conversationId || null,
			bio: updated.bio || (_currentUser && _currentUser.bio) || stored.bio || "",
			email: stored.email || "",
		};
		localStorage.setItem("user", JSON.stringify(newStored));

		closeEditProfile();
	} catch {
		console.error("Failed to update profile");
	}
}
