// A contact's profile: picture, name (renamable just for this user), bio,
// last seen, username and email (tap to copy), and what can be done with
// the chat.
import { useEffect, useRef, useState } from "react";
import type { ContactRow } from "../../../shared/api/types";
import { useNow } from "../../../shared/lib/hooks";
import { timeAgo } from "../../../shared/lib/time";
import { Avatar } from "../../../shared/ui/Avatar";
import { Icons } from "../../../shared/ui/icons";
import { pressable } from "../../../shared/ui/pressable";
import { deleteChat, deleteContact, rename, setArchived, toggleBlock } from "../../services/actions";
import { closePanel } from "../../services/navigation";
import { displayName, isDeletedAccount, isOnline } from "../../state/contactModel";
import { useRow, useUi } from "../selectors";
import { ResponsivePanel } from "./ResponsivePanel";

function Copyable({ label, value, id }: { label: string; value: string; id: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return undefined;
		const t = window.setTimeout(() => setCopied(false), 1500);
		return () => window.clearTimeout(t);
	}, [copied]);
	const copy = () => {
		navigator.clipboard?.writeText(value).then(
			() => setCopied(true),
			() => undefined,
		);
	};
	return (
		<div id={id}>
			<p>{label}</p>
			<h3 className="copyable" {...pressable(copy)} aria-label={`${label}: ${value}. Tap to copy.`}>
				{copied ? "Copied!" : value}
			</h3>
		</div>
	);
}

function Profile({ row }: { row: ContactRow }) {
	const [editing, setEditing] = useState(false);
	const nameEl = useRef<HTMLHeadingElement>(null);
	const now = useNow(30_000);
	const deleted = isDeletedAccount(row);
	const person = row.contact;
	const name = displayName(row);
	const online = isOnline(row);
	const nameNow = useRef(name);
	nameNow.current = name;

	// a new contact (or a change from elsewhere) ends a rename in progress
	useEffect(() => setEditing(false), [row.conversationId]);

	useEffect(() => {
		if (!editing || !nameEl.current) return;
		const el = nameEl.current;
		// the name is filled in once, when editing starts
		el.textContent = nameNow.current;
		el.focus();
		const range = document.createRange();
		range.selectNodeContents(el);
		range.collapse(false);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
	}, [editing]);

	const finishRename = () => {
		const typed = nameEl.current?.textContent ?? "";
		setEditing(false);
		void rename(row, typed);
	};

	let status = "";
	if (!deleted) {
		if (online) status = "Online";
		else if (person?.lastSeen) status = `Last seen ${timeAgo(person.lastSeen, now)}`;
	}

	return (
		<>
			<div className="contact-detail-pic">
				<div className="detail-picture">
					<Avatar name={name} picture={person?.profilePics[0]} className="contact-profile" online={online} deleted={deleted} />
				</div>
				<button type="button" aria-label="Close profile" onClick={closePanel}>
					<Icons.Back />
				</button>
			</div>
			<div className="contact-profile-actions">
				<div className="contact-detail-name">
					<div>
						{editing && (
							<button type="button" className="name-edit-btn" aria-label="Cancel" onClick={() => setEditing(false)}>
								<Icons.CloseThin />
							</button>
						)}
						{editing ? (
							<h3
								ref={nameEl}
								className="editing"
								contentEditable
								suppressContentEditableWarning
								role="textbox"
								aria-label="Name for this contact"
								dir="auto"
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										finishRename();
									} else if (e.key === "Escape") {
										e.preventDefault();
										e.stopPropagation();
										setEditing(false);
									}
								}}
								onPaste={(e) => {
									// plain text only
									e.preventDefault();
									document.execCommand("insertText", false, e.clipboardData.getData("text/plain").replace(/\s+/g, " "));
								}}
							/>
						) : (
							<h3 dir="auto">{name}</h3>
						)}
						{editing && (
							<button type="button" className="name-edit-btn" aria-label="Save name" onClick={finishRename}>
								<Icons.Check />
							</button>
						)}
					</div>
					{!deleted && person?.bio ? <h6 dir="auto">{person.bio}</h6> : null}
					<p>{status}</p>
				</div>
				{!deleted && (person?.username || person?.email) && (
					<div className="contact-info">
						{person?.username && <Copyable id="contact-username" label="Username" value={`@${person.username}`} />}
						{person?.email && <Copyable id="contact-email" label="Email" value={person.email} />}
					</div>
				)}
				<div className="contact-actions">
					{!deleted && (
						<div {...pressable(() => setEditing(true))} id="edit-name-btn">
							Edit Name
						</div>
					)}
					{!deleted && (
						<div {...pressable(() => void toggleBlock(row))} id="block-contact-btn">
							{row.isBlocked ? "Unblock Contact" : "Block Contact"}
						</div>
					)}
					<div
						{...pressable(() => {
							if (row.isArchived) void setArchived(row, false);
							else {
								closePanel();
								void setArchived(row, true);
							}
						})}
						id="archive-contact-btn"
					>
						{row.isArchived ? "Unarchive Chat" : "Archive Chat"}
					</div>
					<div
						{...pressable(() => {
							closePanel();
							deleteChat(row);
						})}
						id="delete-chat-btn"
						className="danger"
					>
						Delete Chat
					</div>
					<div
						{...pressable(() => {
							closePanel();
							deleteContact(row);
						})}
						id="delete-contact-btn"
						className="danger"
					>
						Delete Contact
					</div>
				</div>
			</div>
		</>
	);
}

export function ProfilePanel({ phone }: { phone: boolean }) {
	const open = useUi((s) => s.panel === "profile" && s.openConvId !== null);
	const convId = useUi((s) => s.openConvId);
	const row = useRow(convId);
	// the profile being closed keeps its contact while it slides away
	const last = useRef<ContactRow | null>(null);
	if (row && open) last.current = row;
	const shown = open ? row : last.current;

	return (
		<ResponsivePanel open={open && !!row && !row.isSaved} phone={phone} panelClass="contact-profile-details" dialogClass="profile-dialog" onClose={closePanel} label="Profile">
			{shown && <Profile row={shown} />}
		</ResponsivePanel>
	);
}
