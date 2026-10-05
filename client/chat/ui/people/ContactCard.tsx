// A contact's card in the Contacts grid (also in All contacts and search).
import { memo, useRef, useState, type MouseEvent } from "react";
import type { ContactRow } from "../../../shared/api/types";
import { useEscape, useOutsidePointer } from "../../../shared/lib/hooks";
import { Avatar } from "../../../shared/ui/Avatar";
import { Icons } from "../../../shared/ui/icons";
import { deleteChat, toggleMute, togglePinChat } from "../../services/actions";
import { openChat } from "../../services/navigation";
import { displayName, isDeletedAccount, isOnline, previewText } from "../../state/contactModel";

export interface ContactCardProps {
	row: ContactRow;
	meId: number | null;
	/** fading out while an Undo is possible */
	fading?: boolean;
}

export const ContactCard = memo(function ContactCard({ row, meId, fading = false }: ContactCardProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const card = useRef<HTMLDivElement>(null);
	useOutsidePointer([card], () => setMenuOpen(false), menuOpen);
	useEscape(() => setMenuOpen(false), menuOpen);

	const name = displayName(row);
	const preview = previewText(row.lastMessage, meId);
	const hasMessages = !!row.lastMessage;

	const act = (fn: () => void) => (e: MouseEvent) => {
		e.stopPropagation();
		setMenuOpen(false);
		fn();
	};

	const open = () => {
		if (menuOpen) setMenuOpen(false);
		else openChat(row.conversationId);
	};

	return (
		<div
			ref={card}
			className={`contacts-card${fading ? " fading-slow" : ""}`}
			style={fading ? { opacity: 0, pointerEvents: "none" } : undefined}
			onClick={open}
		>
			{/* the card's own button, for the keyboard and screen readers (the whole card is clickable) */}
			<button
				type="button"
				className="card-open-btn visually-hidden"
				tabIndex={menuOpen ? -1 : 0}
				onClick={(e) => {
					e.stopPropagation();
					open();
				}}
			>
				Open chat with {name}
			</button>
			<button
				type="button"
				className={`contact-menu-btn${menuOpen ? " contact-menu-btn--back" : ""}`}
				aria-label={menuOpen ? "Close options" : "Chat options"}
				aria-expanded={menuOpen}
				onClick={(e) => {
					e.stopPropagation();
					setMenuOpen((v) => !v);
				}}
			>
				{menuOpen ? <Icons.Back size={18} /> : <Icons.Dots />}
			</button>
			<div
				className={`contact-menu-overlay${menuOpen ? " active" : ""}`}
				onClick={(e) => {
					e.stopPropagation();
					setMenuOpen(false);
				}}
			/>
			<div className={`contact-menu-panel${menuOpen ? " active" : ""}`}>
				<button type="button" className="contact-menu-item" tabIndex={menuOpen ? 0 : -1} aria-label={row.isMuted ? "Unmute" : "Mute"} onClick={act(() => toggleMute(row))}>
					<span className="contact-menu-icon">{row.isMuted ? <Icons.Unmute /> : <Icons.Mute />}</span>
				</button>
				<button type="button" className="contact-menu-item" tabIndex={menuOpen ? 0 : -1} aria-label={row.isPinned ? "Unpin" : "Pin"} onClick={act(() => togglePinChat(row))}>
					<span className="contact-menu-icon">{row.isPinned ? <Icons.Unpin size={18} /> : <Icons.Pin size={18} />}</span>
				</button>
				{hasMessages && (
					<button
						type="button"
						className="contact-menu-item contact-menu-item--danger"
						tabIndex={menuOpen ? 0 : -1}
						aria-label="Delete chat"
						onClick={act(() => deleteChat(row))}
					>
						<span className="contact-menu-icon">
							<Icons.Delete size={18} />
						</span>
					</button>
				)}
			</div>
			<Avatar name={name} picture={row.contact?.profilePics[0]} className="contact-profile" online={isOnline(row)} deleted={isDeletedAccount(row)} />
			<span className="contact-name" dir="auto">
				<span className="contact-name-text">{name}</span>
				{row.isMuted && (
					<span className="contact-muted-icon">
						<Icons.Mute />
					</span>
				)}
			</span>
			<span className="contact-message">
				{row.isBlocked ? (
					<span className="blocked-badge">Blocked</span>
				) : !hasMessages ? (
					<span className="send-message">Send message</span>
				) : (
					<span className="last-message" dir="auto">
						{preview}
					</span>
				)}
			</span>
		</div>
	);
});
