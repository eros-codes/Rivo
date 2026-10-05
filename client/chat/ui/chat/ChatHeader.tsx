// The chat's header: back (with the unread count of other chats), picture,
// name and "typing...". Tapping it opens the contact's profile.
import type { ContactRow } from "../../../shared/api/types";
import { useStore } from "../../../shared/lib/store";
import { Avatar } from "../../../shared/ui/Avatar";
import { Icons } from "../../../shared/ui/icons";
import { closeChat, openPanel } from "../../services/navigation";
import { displayName, isDeletedAccount, isOnline } from "../../state/contactModel";
import { contacts, typing } from "../../state/stores";

export function ChatHeader({ row, withPinnedBar }: { row: ContactRow; withPinnedBar: boolean }) {
	const isTyping = useStore(typing, (s) => (s[row.conversationId] ?? 0) > Date.now());
	// unread messages in the other chats
	const elsewhere = useStore(contacts, (s) =>
		Object.values(s.byConv).reduce((n, r) => (r.conversationId === row.conversationId ? n : n + (r.unreadCount || 0)), 0),
	);
	const online = isOnline(row);
	const name = displayName(row);

	return (
		<header
			className={`chat-header${withPinnedBar ? " chat-header-radius-top" : ""}`}
			onClick={() => {
				if (!row.isSaved) openPanel("profile");
			}}
		>
			<span
				className="chat-back"
				role="button"
				tabIndex={0}
				aria-label={elsewhere ? `Back, ${elsewhere} unread` : "Back"}
				onClick={(e) => {
					e.stopPropagation();
					closeChat();
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						e.stopPropagation();
						closeChat();
					}
				}}
			>
				<Icons.Back />
				<span className="unread-message-count" style={{ opacity: elsewhere ? 1 : 0 }}>
					{elsewhere > 999 ? "999+" : elsewhere}
				</span>
			</span>
			{row.isSaved ? (
				<span className="chat-profile saved-icon">
					<Icons.Saved className="saved-icon-svg" />
				</span>
			) : (
				<span className={`chat-profile${online ? " online" : ""}`}>
					<Avatar name={name} picture={row.contact?.profilePics[0]} className="chat-profile-picture" online={online} deleted={isDeletedAccount(row)} />
				</span>
			)}
			<span className="chat-name" dir="auto">
				{name}
			</span>
			{!row.isSaved && (
				// the whole header opens the profile; this is its keyboard way in
				<button
					type="button"
					className="visually-hidden"
					onClick={(e) => {
						e.stopPropagation();
						openPanel("profile");
					}}
				>
					View profile
				</button>
			)}
			<span className="chat-typing-status" aria-live="polite">
				{isTyping ? "typing..." : ""}
			</span>
		</header>
	);
}
