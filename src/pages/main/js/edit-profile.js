import Cropper from "cropperjs";
import { updateMe, uploadAvatar, deleteAvatar } from "./api.js";
import { mountAvatar } from "../../../utils/dom.js";
import { getCurrentUser } from "./currentUser.js";
import { isValidUsername } from "../../auth/js/auth-validate.js";
import { showToast } from "./ui.js";

const AVATAR_SIZE = 400;
const NAME_MIN = 2;
const NAME_MAX = 100;
const BIO_MAX = 300;

// The installed cropperjs (2.x) is built from web components and has another
// API than 1.x (`getCroppedCanvas` no longer exists); both are supported.
const CROPPER_V2 = typeof Cropper?.prototype?.getCropperSelection === "function";
// A square selection over the picture: drag the frame to move it, drag
// outside it to move the picture, wheel / pinch to zoom.
const CROPPER_V2_TEMPLATE =
	"<cropper-canvas background>" +
	'<cropper-image initial-center-size="cover" scalable translatable></cropper-image>' +
	'<cropper-shade theme-color="rgba(0, 0, 0, 0.55)"></cropper-shade>' +
	'<cropper-handle action="move" plain></cropper-handle>' +
	'<cropper-selection initial-coverage="0.8" aspect-ratio="1" movable resizable outlined>' +
	'<cropper-grid role="grid" bordered covered></cropper-grid>' +
	"<cropper-crosshair centered></cropper-crosshair>" +
	'<cropper-handle action="move" theme-color="rgba(255, 255, 255, 0.35)"></cropper-handle>' +
	'<cropper-handle action="n-resize"></cropper-handle>' +
	'<cropper-handle action="e-resize"></cropper-handle>' +
	'<cropper-handle action="s-resize"></cropper-handle>' +
	'<cropper-handle action="w-resize"></cropper-handle>' +
	'<cropper-handle action="ne-resize"></cropper-handle>' +
	'<cropper-handle action="nw-resize"></cropper-handle>' +
	'<cropper-handle action="se-resize"></cropper-handle>' +
	'<cropper-handle action="sw-resize"></cropper-handle>' +
	"</cropper-selection>" +
	"</cropper-canvas>";

let _dom = {};
let _currentUser = null;
let _cropper = null;
let _imageUrl = null;
// a newer file replaces an older one that is still loading
let _loadToken = 0;
let _uploading = false;
let _avatarBusy = false;
let _saving = false;
// "dialog" (wide screens) or "panel" (phones), remembered so closing works
// even if the window was resized in between
let _mode = null;
let _panelHome = null;

// After being shown in the desktop dialog the panel goes back to its place in
// the page, so the phone layout can still show it.
function _returnPanelHome() {
	const panel = _dom.editProfilePanel;
	if (!panel) return;
	panel.style.display = "";
	panel.classList.remove("slide-in", "slide-out");
	if (_panelHome && _panelHome.parent && panel.parentNode !== _panelHome.parent) {
		const next = _panelHome.next && _panelHome.next.parentNode === _panelHome.parent ? _panelHome.next : null;
		_panelHome.parent.insertBefore(panel, next);
	}
}

// mountAvatar() replaces the avatar element, so the one captured at start-up
// goes stale after the first change: always look the wrapper up again.
function _avatarWrapper() {
	return _dom.editProfilePanel?.querySelector(".edit-profile-avatar-wrapper") || null;
}

function _hasPicture() {
	const pics = _currentUser?.profilePics;
	return Array.isArray(pics) && pics.length > 0 && !!pics[0];
}

function _renderAvatar() {
	const target = _avatarWrapper() || _dom.editProfileAvatar;
	if (!target) return;
	mountAvatar(target, {
		// the letter comes from the name, as other people see it
		name: _currentUser?.name || _currentUser?.username || "",
		nickname: "",
		profilePics: Array.isArray(_currentUser?.profilePics) ? _currentUser.profilePics : [],
		className: "edit-profile-avatar",
	});
	if (_dom.deleteAvatarBtn) _dom.deleteAvatarBtn.style.display = _hasPicture() ? "" : "none";
}

// Keeps the stored copy of the signed-in user in step (other fields stay)
function _storeUser(changes) {
	try {
		const stored = getCurrentUser() || {};
		localStorage.setItem("user", JSON.stringify({ ...stored, ...changes }));
	} catch (e) {
		/* storage full or blocked: the page still has the new values */
	}
}

function _setAvatarBusy(busy) {
	_avatarBusy = busy;
	const wrapper = _avatarWrapper();
	if (wrapper) wrapper.classList.toggle("uploading", busy);
	if (_dom.avatarBtn) _dom.avatarBtn.disabled = busy;
	if (_dom.deleteAvatarBtn) _dom.deleteAvatarBtn.disabled = busy;
}

// ─── Cropping ─────────────────────────────────────────────────────────────────
function _destroyCropper() {
	if (_cropper) {
		try {
			_cropper.destroy();
		} catch (e) {
			/* ignore */
		}
		_cropper = null;
	}
}

function _resetCropState() {
	_loadToken += 1;
	_destroyCropper();
	if (_dom.avatarCropImage) {
		_dom.avatarCropImage.onload = null;
		_dom.avatarCropImage.onerror = null;
		_dom.avatarCropImage.removeAttribute("src");
	}
	if (_dom.avatarFileInput) _dom.avatarFileInput.value = "";
	if (_imageUrl) {
		try {
			URL.revokeObjectURL(_imageUrl);
		} catch (e) {
			/* ignore */
		}
		_imageUrl = null;
	}
	if (_dom.avatarCropConfirm) _dom.avatarCropConfirm.disabled = false;
}

function _closeCropDialog() {
	if (_dom.avatarCropDialog?.open) _dom.avatarCropDialog.close();
	else _resetCropState();
}

function _openCropper(file) {
	if (!file) return;
	if (file.type && !file.type.startsWith("image/")) {
		showToast("Please choose an image file");
		_dom.avatarFileInput.value = "";
		return;
	}
	_resetCropState();
	const token = _loadToken;
	_imageUrl = URL.createObjectURL(file);
	const img = _dom.avatarCropImage;
	img.onload = () => {
		if (token !== _loadToken) return;
		try {
			_cropper = CROPPER_V2
				? new Cropper(img, { template: CROPPER_V2_TEMPLATE })
				: new Cropper(img, { aspectRatio: 1, viewMode: 2, dragMode: "move" });
		} catch (e) {
			console.error("cropper failed", e);
			showToast("This image can't be edited. Please try another one.");
			_closeCropDialog();
		}
	};
	img.onerror = () => {
		if (token !== _loadToken) return;
		showToast("This image can't be opened. Please try another one.");
		_closeCropDialog();
	};
	img.src = _imageUrl;
	if (!_dom.avatarCropDialog.open) _dom.avatarCropDialog.showModal();
}

function _canvasToBlob(canvas) {
	return new Promise((resolve) => {
		try {
			canvas.toBlob((blob) => resolve(blob || null), "image/jpeg", 0.9);
		} catch (e) {
			resolve(null);
		}
	});
}

// JPEG has no transparency: empty corners become white instead of black
function _whiteBackground(ctx, canvas) {
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
}

async function _croppedBlob() {
	if (!_cropper) return null;
	let canvas = null;
	if (CROPPER_V2) {
		const selection = _cropper.getCropperSelection();
		if (!selection || !selection.width || !selection.height) return null;
		canvas = await selection.$toCanvas({
			width: AVATAR_SIZE,
			height: AVATAR_SIZE,
			beforeDraw: _whiteBackground,
		});
	} else {
		canvas = _cropper.getCroppedCanvas({
			width: AVATAR_SIZE,
			height: AVATAR_SIZE,
			fillColor: "#fff",
			imageSmoothingQuality: "high",
		});
	}
	return canvas ? _canvasToBlob(canvas) : null;
}

async function _applyCrop() {
	if (_uploading || !_cropper) return;
	_uploading = true;
	_dom.avatarCropConfirm.disabled = true;
	try {
		let blob = null;
		try {
			blob = await _croppedBlob();
		} catch (e) {
			console.error("crop failed", e);
		}
		if (!blob) {
			showToast("Couldn't crop this image. Please try again.");
			return;
		}

		const formData = new FormData();
		formData.append("avatar", blob, "avatar.jpg");
		_setAvatarBusy(true);
		let res = null;
		try {
			res = await uploadAvatar(formData);
		} catch (e) {
			showToast(e?.message && e.status && e.status < 500 ? e.message : "Upload failed. Please try again.");
			return;
		} finally {
			_setAvatarBusy(false);
		}
		if (!res || !res.url) {
			showToast("Upload failed. Please try again.");
			return;
		}

		if (_currentUser) _currentUser.profilePics = [res.url];
		_storeUser({ profilePics: [res.url] });
		_renderAvatar();
		_closeCropDialog();
	} finally {
		_uploading = false;
		if (_dom.avatarCropConfirm) _dom.avatarCropConfirm.disabled = false;
	}
}

async function _removeAvatar() {
	if (_avatarBusy || !_hasPicture()) return;
	_setAvatarBusy(true);
	try {
		await deleteAvatar();
	} catch (e) {
		showToast("Couldn't remove the picture. Please try again.");
		return;
	} finally {
		_setAvatarBusy(false);
	}
	if (_currentUser) _currentUser.profilePics = [];
	_storeUser({ profilePics: [] });
	_renderAvatar();
}

/**
 * @param {{
 *   editProfilePanel, editProfileDialog,
 *   editProfileClose, editProfileSave,
 *   editNameInput, editUsernameInput, editBioInput,
 *   editProfileAvatar, avatarBtn, avatarFileInput, deleteAvatarBtn,
 *   avatarCropDialog, avatarCropImage,
 *   avatarCropCancel, avatarCropConfirm,
 * }} dom
 */
export function initEditProfile(dom) {
	_dom = dom;
	if (dom.editProfilePanel && dom.editProfilePanel.parentNode) {
		_panelHome = { parent: dom.editProfilePanel.parentNode, next: dom.editProfilePanel.nextSibling };
	}

	if (_dom.editNameInput) _dom.editNameInput.maxLength = NAME_MAX;
	if (_dom.editUsernameInput) _dom.editUsernameInput.maxLength = 31; // room for a typed "@"
	if (_dom.editBioInput) _dom.editBioInput.maxLength = BIO_MAX;

	_dom.editProfileClose.addEventListener("click", closeEditProfile);
	_dom.editProfileDialog.addEventListener("click", (e) => {
		if (e.target === _dom.editProfileDialog) closeEditProfile();
	});
	// Esc closes the dialog natively: put the panel back as well
	_dom.editProfileDialog.addEventListener("close", () => {
		if (_mode === "dialog") {
			_mode = null;
			_returnPanelHome();
		}
	});
	_dom.editProfileSave.addEventListener("click", _handleSave);

	_dom.avatarBtn.addEventListener("click", () => {
		if (_avatarBusy) return;
		_dom.avatarFileInput.click();
	});
	_dom.avatarFileInput.addEventListener("change", (e) => {
		_openCropper(e.target.files && e.target.files[0]);
	});

	_dom.avatarCropCancel.addEventListener("click", _closeCropDialog);
	_dom.avatarCropConfirm.addEventListener("click", _applyCrop);
	// no closing with Esc while the picture is being uploaded
	_dom.avatarCropDialog.addEventListener("cancel", (e) => {
		if (_uploading) e.preventDefault();
	});
	// however the dialog closes (buttons or Esc), the cropper is cleaned up
	_dom.avatarCropDialog.addEventListener("close", _resetCropState);

	_dom.deleteAvatarBtn.addEventListener("click", _removeAvatar);
}

export function openEditProfile(user) {
	_currentUser = user;
	_dom.editNameInput.value = user?.name || "";
	_dom.editUsernameInput.value = user?.username || "";
	_dom.editBioInput.value = user?.bio || "";
	_renderAvatar();

	const panel = _dom.editProfilePanel;
	if (window.innerWidth > 700) {
		_mode = "dialog";
		// an inline display left by the phone layout would hide it here
		panel.style.display = "";
		panel.classList.remove("slide-in", "slide-out");
		_dom.editProfileDialog.appendChild(panel);
		if (!_dom.editProfileDialog.open) _dom.editProfileDialog.showModal();
	} else {
		_mode = "panel";
		if (_panelHome && panel.parentNode !== _panelHome.parent) _returnPanelHome();
		panel.style.display = "flex";
		panel.classList.remove("slide-out");
		panel.classList.add("slide-in");
		panel.addEventListener(
			"animationend",
			() => {
				panel.classList.remove("slide-in");
			},
			{ once: true },
		);
	}
}

export function closeEditProfile() {
	const mode = _mode;
	_mode = null;
	const panel = _dom.editProfilePanel;
	if (mode === "dialog") {
		try {
			if (_dom.editProfileDialog.open) _dom.editProfileDialog.close();
		} catch (e) {
			/* ignore */
		}
		_returnPanelHome();
	} else if (mode === "panel") {
		// an invisible panel never fires animationend
		if (getComputedStyle(panel).display === "none") {
			panel.style.display = "";
			return;
		}
		panel.classList.remove("slide-in");
		panel.classList.add("slide-out");
		panel.addEventListener(
			"animationend",
			() => {
				panel.classList.remove("slide-out");
				panel.style.display = "";
			},
			{ once: true },
		);
	}
}

async function _handleSave() {
	if (_saving) return;
	const name = _dom.editNameInput.value.trim();
	const username = _dom.editUsernameInput.value.trim().replace(/^@/, "");
	const bio = _dom.editBioInput.value.trim();

	if (name.length < NAME_MIN || name.length > NAME_MAX) {
		showToast(`Name must be ${NAME_MIN}-${NAME_MAX} characters`);
		_dom.editNameInput.focus();
		return;
	}
	if (!isValidUsername(username)) {
		showToast("Username must be 3-30 characters: letters, numbers or underscores");
		_dom.editUsernameInput.focus();
		return;
	}
	if (bio.length > BIO_MAX) {
		showToast(`Bio must be ${BIO_MAX} characters or fewer`);
		_dom.editBioInput.focus();
		return;
	}

	const changes = {};
	if (name !== (_currentUser?.name || "")) changes.name = name;
	if (username !== (_currentUser?.username || "")) changes.username = username;
	if (bio !== (_currentUser?.bio || "")) changes.bio = bio;
	if (Object.keys(changes).length === 0) {
		closeEditProfile();
		return;
	}

	_saving = true;
	_dom.editProfileSave.disabled = true;
	try {
		const updated = await updateMe(changes);
		const next = {
			name: updated?.name ?? name,
			username: updated?.username ?? username,
			bio: updated?.bio ?? bio,
		};
		if (_currentUser) Object.assign(_currentUser, next);
		_storeUser({ ...next, nickname: next.username });
		// the initial letter follows the name
		_renderAvatar();
		closeEditProfile();
		showToast("Profile updated");
	} catch (e) {
		showToast(e?.message && e.status && e.status < 500 ? e.message : "Couldn't save your profile. Please try again.");
	} finally {
		_saving = false;
		_dom.editProfileSave.disabled = false;
	}
}
