import { createActiveChatCard } from "../../../components/active-chats/active-chats.js";
import { createContactCard } from "../../../components/contact-cards/contact-card.js";
import { applyReactionsToMessage, createMessage, markMessagesAsSeen } from "../../../components/messages/messages.js";
import { getContacts } from "./api.js";
import { moveToActiveChats, moveToContacts, refreshCard, sortActiveChats, sortContacts, updateTotalUnreadCount } from "./chat-logic.js";
import { loadOlderMessages } from "./chat-paging.js";
import { updatePinnedData, updatePinnedMessage } from "./chat-pinned.js";
import { createDateSeparator } from "./chat-render.js";
import { nearBottom, scrollChatToBottom, scrollChatToBottomAfterPadding } from "./chat-scroll.js";
import { _currentUserId, _dom, _localNotifQueue, basePadding, getContactPreviewText, lineHeight, maxLines } from "./chat-state.js";
import { getCurrentUser } from "./currentUser.js";
import { showNotification } from "./in-app-notification.js";
import { emitMessageSeen } from "./socket.js";
import { contacts, messages, state } from "./state.js";
import { hideEmptyState } from "./ui.js";

export async function receiveMessage(message) {
	try { console.log('[chat] receiveMessage START', { messageId: message.id, conversationId: message.conversationId, senderId: message.senderId }); } catch (e) {}
	let contact = contacts.find(
		(c) => c.conversationId === message.conversationId,
	);
	try { console.log('[chat] receiveMessage contact resolved', contact ? { id: contact.id, conversationId: contact.conversationId } : null); } catch (e) {}

	// If we don't know about this conversation yet, try to refresh contacts
	// from the server (handles case where someone added the current user).
	if (!contact) {
		try {
			const serverContacts = await getContacts();
			if (Array.isArray(serverContacts)) {
				const raw = serverContacts.find(
					(c) => c.conversationId === message.conversationId,
				);
				if (raw) {
					const resolvedName =
						raw.nickname || raw.contact?.name || "";
					const anonUsernameRaw = raw.contact?.username || "";
					const anonEmailRaw = raw.contact?.email || "";
					const isDeletedAccount =
						resolvedName &&
						String(resolvedName).toLowerCase() ===
							"deleted account";
					const isAnonPlaceholder =
						(anonUsernameRaw &&
							String(anonUsernameRaw).startsWith(
								"deleted_user_",
							)) ||
						(anonEmailRaw &&
							String(anonEmailRaw).endsWith("@deleted.rivo"));
					const newContact = {
						...raw,
						name: resolvedName,
						username:
							isDeletedAccount || isAnonPlaceholder
								? ""
								: anonUsernameRaw,
						profilePics: raw.contact?.profilePics || [],
						isOnline: raw.contact?.isOnline || false,
						lastSeen: raw.contact?.lastSeen || null,
						bio: raw.contact?.bio || "",
						email:
							isDeletedAccount || isAnonPlaceholder
								? ""
								: anonEmailRaw,
						lastMessage:
							raw.conversation?.messages?.[0]?.text || "",
						lastMessageTime: raw.conversation?.messages?.[0]
							? new Date(
									raw.conversation.messages[0].createdAt,
								).toLocaleTimeString([], {
									hour: "2-digit",
									minute: "2-digit",
									hour12: false,
								})
							: null,
						lastMessageDate: raw.conversation?.messages?.[0]
							? new Date(raw.conversation.messages[0].createdAt)
									.toISOString()
									.slice(0, 10)
							: null,
						unreadCount: raw.unreadCount ?? 0,
						lastMessageSeen: (() => {
							const lastMsg = raw.conversation?.messages?.[0];
							if (!lastMsg) return true;
							// Treat missing/undefined isSeen as seen. Only explicit false
							// means the last message is unseen.
							return lastMsg.isSeen !== false;
						})(),
					};

					// Avoid duplicates
					if (!contacts.find((c) => c.id === newContact.id)) {
						contacts.push(newContact);

						// append DOM card to the appropriate container (use injected DOM refs)
						const contactsContainer = _dom.contactsContainer;
						const activeChatsContainer = _dom.activeChatsContainer;
						if (contactsContainer && activeChatsContainer) {
							if (
								newContact.isPinned ||
								newContact.unreadCount > 0 ||
								newContact.lastMessageSeen === false
							) {
								activeChatsContainer.appendChild(
									createActiveChatCard(newContact),
								);
							} else {
								contactsContainer.appendChild(
									createContactCard(
										{
											...newContact,
											hasMessages:
												!!newContact.lastMessage,
										},
										_dom.onContactAction,
									),
								);
							}
							updateTotalUnreadCount();
							sortActiveChats();
							sortContacts();
							// Hide the "No contacts yet" placeholder immediately
							const emptyEl =
								document.getElementById("contacts-empty");
							if (emptyEl) emptyEl.style.display = "none";
						}
					}

					contact = contacts.find(
						(c) => c.conversationId === message.conversationId,
					);
				}
			}
		} catch (e) {
			console.error("receiveMessage: failed to sync contacts", e);
		}
		if (!contact) return;
	}

	const normalized = {
		id: message.id,
		user: message.senderId === _currentUserId(),
		text: message.text,
		time: new Date(message.createdAt).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}),
		date: new Date(message.createdAt).toISOString().slice(0, 10),
		isEdited: false,
		isPinned: false,
		isSeen: message.isSeen || false,
		isOneTime: message.isOneTime || false,
		isTimeCapsule: message.isTimeCapsule || false,
		scheduledFor: message.scheduledFor || null,
		openedAt: message.openedAt || null,
		isLocked: message.isLocked || false,
		replyTo: message.replyToId
			? {
					id: message.replyToId,
					sender: message.replyToName,
					text: message.replyToText,
				}
			: null,
		forwardedFrom: message.forwardedFrom || null,
		forwardedText: message.forwardedText || null,
		reactions: message.reactions || [],
	};

	if (!messages[contact.id]) messages[contact.id] = [];
	messages[contact.id].push(normalized);

	// Do not trim messages immediately on receive to avoid jarring the user
	// (e.g., when they're reading older history). Trimming is performed
	// when loading older messages (see `loadOlderMessages`) so that
	// history-reading is not interrupted.

	// اگه همین چت بازه نشون بده
	if (state.contactUserId === contact.id) {
		hideEmptyState(_dom.chatEl, _dom.emptyStateEl);
		normalized.index = messages[contact.id].length - 1;
		// If this incoming message falls on a different day than the previous
		// message, insert a date separator before appending it so the UI
		// updates live without requiring a refresh.
		const prevMsg = messages[contact.id][normalized.index - 1] || null;
		if (!prevMsg || prevMsg.date !== normalized.date) {
			_dom.chatEl.appendChild(createDateSeparator(normalized.date));
		}
		const newEl = createMessage(normalized);
		try {
			if (normalized.reactions && normalized.reactions.length > 0) {
				const _cu = getCurrentUser();
				applyReactionsToMessage(
					newEl,
					normalized.reactions,
					_cu?.id || null,
				);
			}
		} catch (e) {
			/* ignore */
		}
		// If the user is currently scrolled to the bottom, append and mark seen.
		// Otherwise, append but do not auto-scroll; show a "scroll to bottom"
		// affordance so the user can jump to the newest messages.
					try {
					const wasAtBottom = nearBottom(_dom.chatEl);
					_dom.chatEl.appendChild(newEl);
					if (wasAtBottom) {
					scrollChatToBottom();
					emitMessageSeen(contact.conversationId);
				} else {
					try {
						const btn = _dom.scrollToBottomBtn;
						if (btn) btn.classList.add('visible');
					} catch (e) {}
				}
		} catch (e) {
			// fallback: append + scroll
			_dom.chatEl.appendChild(newEl);
			scrollChatToBottom();
			emitMessageSeen(contact.conversationId);
		}
	}

	// کارت رو آپدیت کن
	// Use centralized preview helper so locked time-capsule content is never exposed
	contact.lastMessage = getContactPreviewText(normalized);
	contact.lastMessageTime = normalized.time;
	contact.lastMessageDate = normalized.date;
	// If the chat is currently open, consider the last message seen locally
	contact.lastMessageSeen = state.contactUserId === contact.id ? true : false;
	if (state.contactUserId !== contact.id) {
		contact.unreadCount = (contact.unreadCount || 0) + 1;
		try {
			if (!normalized.user && !contact.isSaved && !contact.isMuted) {
				const notifQueue = _localNotifQueue;
				if (normalized.id) {
					if (!notifQueue.has(normalized.id)) {
						notifQueue.add(normalized.id);
						setTimeout(
							() => notifQueue.delete(normalized.id),
							5000,
						);
						showNotification(contact, normalized);
					}
				} else {
					showNotification(contact, normalized);
				}
			}
		} catch (e) {
			// ignore notification errors
		}
	}

	// Do not auto-unarchive when receiving a message. Keep archived contacts archived
	// until the local user explicitly sends a message (auto-unarchive on send).
	if (!contact.isArchived) {
		moveToActiveChats(contact);
	}
	refreshCard(contact);
	sortActiveChats();
}

export function handleOnetimeDeleted({ messageIds }) {
	if (!Array.isArray(messageIds) || messageIds.length === 0) return;
	const idSet = new Set(messageIds.map(String));

	// First: apply a small fade/scale animation to any visible DOM nodes
	try {
		if (_dom && _dom.chatEl) {
			messageIds.forEach((id) => {
				const el = _dom.chatEl.querySelector(
					`.chat-message[data-message-id="${id}"]`,
				);
				if (el) {
					el.style.transition =
						"opacity 0.3s ease, transform 0.3s ease";
					el.style.opacity = "0";
					el.style.transform = "scale(0.95)";
				}
			});
		}
	} catch (e) {
		/* ignore animation errors */
	}

	// After animation completes, remove messages from memory, update UI and contact previews
	setTimeout(() => {
		const affectedUids = new Set();

		for (const [_uid, msgs] of Object.entries(messages)) {
			if (!Array.isArray(msgs)) continue;
			const before = msgs.length;
			const filtered = msgs.filter((m) => !idSet.has(String(m.id)));
			if (filtered.length !== before) {
				messages[Number(_uid)] = filtered;
				filtered.forEach((m, i) => {
					m.index = i;
				});
				affectedUids.add(Number(_uid));
			}
		}

					// Remove any pinned cache entries for the deleted messages so the
					// pinned banner doesn't show stale content.
					try {
						for (const uid of affectedUids) {
							for (const mid of idSet) {
								try { updatePinnedData(Number(uid), mid, null, false); } catch (e) {}
							}
						}
					} catch (e) {}

		// Remove DOM nodes if still present (safety) and re-render open conversation
		try {
			if (_dom && _dom.chatEl) {
				messageIds.forEach((id) => {
					const el = _dom.chatEl.querySelector(
						`.chat-message[data-message-id="${id}"]`,
					);
					if (el && el.parentNode) el.parentNode.removeChild(el);
				});
			}
		} catch (e) {
			/* ignore DOM cleanup errors */
		}

		// If the currently open conversation was affected, re-render and update pinned
		try {
			if (
				state.contactUserId &&
				affectedUids.has(Number(state.contactUserId))
			) {
				// Update DOM indices incrementally instead of full re-render.
				try {
					const uid = Number(state.contactUserId);
					if (_dom && _dom.chatEl) {
						const nodes = Array.from(_dom.chatEl.querySelectorAll('.chat-message'));
						nodes.forEach((node) => {
							const mid = node.dataset?.messageId;
							if (!mid) return;
							const newIndex = (messages[uid] || []).findIndex((m) => String(m.id) === String(mid));
							if (newIndex === -1) {
								// message was removed; drop node if still present
								if (node.parentNode) node.parentNode.removeChild(node);
							} else {
								node.dataset.index = newIndex;
							}
						});
						// refresh pinned banner
						updatePinnedMessage();
					}
				} catch (e) {
					/* ignore */
				}
			}
		} catch (e) {
			/* ignore */
		}

		// Update contact previews (lastMessage, unreadCount) for affected conversations
		try {
			for (const uid of affectedUids) {
				const friend = contacts.find((c) => c.id === Number(uid));
				const arr = messages[uid] || [];
				if (friend) {
					if (arr.length > 0) {
						const lastMsg = arr[arr.length - 1];
						friend.lastMessage = getContactPreviewText(lastMsg);
						friend.lastMessageTime = lastMsg.time || "";
						friend.lastMessageDate = lastMsg.date || "";
						friend.lastMessageTs = lastMsg.createdAt || 0;
						friend.lastMessageSeen = lastMsg.user
							? lastMsg.isSeen !== false
							: true;
						try {
							friend.unreadCount = arr.filter(
								(m) => !m.user && m.isSeen !== true,
							).length;
						} catch (e) {
							/* ignore */
						}
					} else {
						friend.lastMessage = "";
						friend.lastMessageTime = "";
						friend.lastMessageDate = "";
						friend.lastMessageTs = 0;
						friend.lastMessageSeen = true;
						friend.unreadCount = 0;
					}
					try {
						refreshCard(friend);
					} catch (e) {
						/* ignore */
					}
				}
			}
			try {
				sortActiveChats();
			} catch (e) {
				/* ignore */
			}
			try {
				sortContacts();
			} catch (e) {
				/* ignore */
			}
			try {
				updateTotalUnreadCount();
			} catch (e) {
				/* ignore */
			}
		} catch (e) {
			/* ignore */
		}

		// Recompute chat padding to avoid leftover spacing after DOM changes
		try {
			if (_dom && _dom.chatEl) {
				const inputEl = _dom.messageInput;
				if (inputEl) {
					let lines = Math.floor(inputEl.scrollHeight / lineHeight);
					if (lines < 1) lines = 1;
					if (lines > maxLines) lines = maxLines;
					if (lines < maxLines) {
						_dom.chatEl.style.paddingBottom =
							basePadding +
							2 * (lines - 1) * 0.75 +
							state.actionPreviewHeight +
							"rem";
					} else {
						_dom.chatEl.style.paddingBottom =
							basePadding +
							2 * ((maxLines - 2) * 0.75 + 0.2) +
							state.actionPreviewHeight +
							"rem";
					}
				} else {
					_dom.chatEl.style.paddingBottom =
						basePadding + state.actionPreviewHeight + "rem";
				}
				// If conversation open, ensure scroll stays correct
				if (state.contactUserId) scrollChatToBottomAfterPadding();
			}
		} catch (e) {
			/* ignore */
		}
	}, 300);
}

// ─── Send message ─────────────────────────────────────────────────────────────

export function _updateContactCard() {
	const userMsgs = messages[state.contactUserId];
	const lastMsg = userMsgs?.at(-1);
	const friend = contacts.find((c) => c.id === state.contactUserId);
	if (friend && lastMsg) {
		friend.lastMessage = getContactPreviewText(lastMsg);
		friend.lastMessageTime = lastMsg.time;
		friend.lastMessageDate = lastMsg.date;
		friend.lastMessageSeen = false; //new outgoing message which 2nd person has not seen
		refreshCard(friend);
		sortActiveChats();
	}
}

export function handleMessagesSeen(
	conversationId,
	messageIds = [],
	seenBy = null,
) {
	const contact = contacts.find((c) => c.conversationId === conversationId);
	if (!contact) return;

	const userMsgs = messages[contact.id];
	const seenIndices = [];

	if (
		Array.isArray(messageIds) &&
		messageIds.length > 0 &&
		Array.isArray(userMsgs)
	) {
		messageIds.forEach((mid) => {
			const idx = userMsgs.findIndex((msg) => msg.id === mid);
			if (idx !== -1) {
				const msg = userMsgs[idx];
				if (msg.user && !msg.isSeen) {
					msg.isSeen = true;
					seenIndices.push(idx);
				}
			}
		});
	}

	// Update DOM only if this conversation is currently open and there are indices
	if (state.contactUserId === contact.id && seenIndices.length > 0) {
		markMessagesAsSeen(_dom.chatEl, seenIndices);
	}

	const currentUserId = _currentUserId();
	const anyMarked = Array.isArray(messageIds) && messageIds.length > 0;

	// Only reset unreadCount for this contact when the current user is the one who saw the messages
	if (seenBy === currentUserId && anyMarked) {
		contact.unreadCount = 0;
	}

	// Also, if the conversation is currently open and messages were marked seen locally, reset unread count
	if (state.contactUserId === contact.id && seenIndices.length > 0) {
		contact.unreadCount = 0;
	}

	if (seenIndices.length > 0 || anyMarked) {
		refreshCard(contact);
		sortActiveChats();
	}

	// If any messages were marked as seen, mark the contact's last message as seen
	if (anyMarked && seenBy !== null && seenBy !== _currentUserId()) {
		contact.lastMessageSeen = true;
		if (
			!contact.isPinned &&
			!contact.isSaved &&
			contact.unreadCount === 0
		) {
			moveToContacts(contact);
			sortContacts();
		}
	}
}