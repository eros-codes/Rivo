// Editing the user's own profile: picture, name, username and bio.
import { useRef, useState } from "react";
import { usersApi } from "../../../shared/api/endpoints";
import { ApiError, errorText } from "../../../shared/api/http";
import { useStore } from "../../../shared/lib/store";
import { Avatar } from "../../../shared/ui/Avatar";
import { Icons } from "../../../shared/ui/icons";
import { showToast } from "../../services/feedback";
import { closePanel } from "../../services/navigation";
import { patchMe, setMe } from "../../services/session";
import { session } from "../../state/stores";
import { useUi } from "../selectors";
import { AvatarCropper } from "./AvatarCropper";
import { ResponsivePanel } from "./ResponsivePanel";
import { BIO_MAX_LENGTH as BIO_MAX, NAME_MAX_LENGTH as NAME_MAX, NAME_MIN_LENGTH as NAME_MIN, USERNAME_PATTERN as USERNAME_RE } from "../../../../shared/limits.ts";


function EditProfile() {
	const me = useStore(session, (s) => s.me);
	const [name, setName] = useState(me?.name ?? "");
	const [username, setUsername] = useState(me?.username ?? "");
	const [bio, setBio] = useState(me?.bio ?? "");
	const [saving, setSaving] = useState(false);
	const [avatarBusy, setAvatarBusy] = useState(false);
	const [cropping, setCropping] = useState<File | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const nameInput = useRef<HTMLInputElement>(null);
	const usernameInput = useRef<HTMLInputElement>(null);
	const bioInput = useRef<HTMLTextAreaElement>(null);
	const hasPicture = !!me?.profilePics[0];

	if (!me) return null;

	const save = async () => {
		if (saving) return;
		const cleanName = name.trim();
		const cleanUsername = username.trim().replace(/^@/, "");
		const cleanBio = bio.trim();
		if (cleanName.length < NAME_MIN || cleanName.length > NAME_MAX) {
			showToast(`Name must be ${NAME_MIN}-${NAME_MAX} characters`, { icon: "error" });
			nameInput.current?.focus();
			return;
		}
		if (!USERNAME_RE.test(cleanUsername)) {
			showToast("Username must be 3-30 characters: letters, numbers or underscores", { icon: "error" });
			usernameInput.current?.focus();
			return;
		}
		if (cleanBio.length > BIO_MAX) {
			showToast(`Bio must be ${BIO_MAX} characters or fewer`, { icon: "error" });
			bioInput.current?.focus();
			return;
		}
		const changes: { name?: string; username?: string; bio?: string } = {};
		if (cleanName !== me.name) changes.name = cleanName;
		if (cleanUsername !== me.username) changes.username = cleanUsername;
		if (cleanBio !== (me.bio || "")) changes.bio = cleanBio;
		if (Object.keys(changes).length === 0) {
			closePanel();
			return;
		}
		setSaving(true);
		try {
			setMe(await usersApi.update(changes));
			closePanel();
			showToast("Profile updated", { icon: "check" });
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				showToast("This username is already taken", { icon: "error" });
				usernameInput.current?.focus();
			} else showToast(errorText(e, "Couldn't save your profile. Please try again."), { icon: "error" });
		} finally {
			setSaving(false);
		}
	};

	const upload = async (jpeg: Blob) => {
		setAvatarBusy(true);
		try {
			const { url } = await usersApi.uploadAvatar(jpeg);
			patchMe({ profilePics: [url] });
			setCropping(null);
		} catch (e) {
			showToast(errorText(e, "Upload failed. Please try again."), { icon: "error" });
		} finally {
			setAvatarBusy(false);
		}
	};

	const removePicture = async () => {
		if (avatarBusy || !hasPicture) return;
		setAvatarBusy(true);
		try {
			setMe(await usersApi.update({ profilePics: [] }));
		} catch (e) {
			showToast(errorText(e, "Couldn't remove the picture. Please try again."), { icon: "error" });
		} finally {
			setAvatarBusy(false);
		}
	};

	return (
		<>
			<div className="edit-profile-banner">
				<button type="button" className="edit-profile-close" aria-label="Close" onClick={closePanel}>
					<Icons.Close />
				</button>
				<div className={`edit-profile-avatar-wrapper${avatarBusy ? " uploading" : ""}`}>
					<Avatar name={me.name || me.username} picture={me.profilePics[0]} className="edit-profile-avatar" />
					<button type="button" className="edit-profile-avatar-btn" aria-label="Change picture" disabled={avatarBusy} onClick={() => fileInput.current?.click()}>
						<Icons.Rotate />
					</button>
					{hasPicture && (
						<button type="button" className="edit-profile-delete-avatar-btn" aria-label="Remove picture" disabled={avatarBusy} onClick={() => void removePicture()}>
							<Icons.Delete />
						</button>
					)}
				</div>
				<input
					ref={fileInput}
					type="file"
					accept="image/jpeg,image/png,image/webp,image/gif"
					hidden
					onChange={(e) => {
						const file = e.target.files?.[0];
						// the same file can be chosen again later
						e.target.value = "";
						if (!file) return;
						if (file.type && !file.type.startsWith("image/")) {
							showToast("Please choose an image file", { icon: "error" });
							return;
						}
						setCropping(file);
					}}
				/>
			</div>
			<form
				className="edit-profile-body"
				noValidate
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<div className="edit-profile-field">
					<label htmlFor="edit-name-input">Name</label>
					<input ref={nameInput} id="edit-name-input" type="text" placeholder="Your name" autoComplete="name" maxLength={NAME_MAX} dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
				</div>
				<div className="edit-profile-field">
					<label htmlFor="edit-username-input">Username</label>
					<input
						ref={usernameInput}
						id="edit-username-input"
						type="text"
						placeholder="@username"
						autoComplete="username"
						autoCapitalize="none"
						spellCheck={false}
						maxLength={31}
						value={username}
						onChange={(e) => setUsername(e.target.value)}
					/>
				</div>
				<div className="edit-profile-field">
					<label htmlFor="edit-bio-input">Bio</label>
					<textarea ref={bioInput} id="edit-bio-input" placeholder="Write something about yourself..." rows={3} maxLength={BIO_MAX} dir="auto" value={bio} onChange={(e) => setBio(e.target.value)} />
				</div>
				<button type="submit" className="edit-profile-save" disabled={saving}>
					{saving ? "Saving…" : "Save Changes"}
				</button>
			</form>
			{cropping && <AvatarCropper file={cropping} busy={avatarBusy} onCancel={() => setCropping(null)} onDone={(b) => void upload(b)} />}
		</>
	);
}

export function EditProfilePanel({ phone }: { phone: boolean }) {
	const open = useUi((s) => s.panel === "editProfile");
	return (
		<ResponsivePanel open={open} phone={phone} panelClass="edit-profile-panel" dialogClass="edit-profile-dialog" onClose={closePanel} label="Edit profile">
			<EditProfile />
		</ResponsivePanel>
	);
}
