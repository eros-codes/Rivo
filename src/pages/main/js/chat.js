// ─────────────────────────────────────────────────────────────────────────────
// chat.js — فایل بازصادرکننده (barrel)
//
// این فایل قبلاً ۲۷۰۹ خط بود. حالا به ماژول‌های زیر شکسته شده:
//
//   chat-state.js    حالت مشترک، ثابت‌ها، initChat
//   chat-scroll.js   کمک‌کننده‌های اسکرول
//   chat-open.js     باز/بسته کردن چت
//   chat-render.js   رندر پیام‌ها و جداکننده‌ها
//   chat-paging.js   بارگذاری پیام‌های قدیمی‌تر
//   chat-pinned.js   پیام‌های سنجاق‌شده
//   chat-receive.js  دریافت پیام، حذف یک‌بارمصرف، وضعیت دیده‌شدن
//   chat-send.js     ارسال پیام و مدیریت پیام‌های در انتظار
//   chat-capsule.js  باز شدن کپسول زمانی
//
// چون همه‌ی خروجی‌های قبلی از همین‌جا دوباره صادر می‌شوند، هیچ فایل دیگری
// (از جمله main.js) نیازی به تغییر import ندارد.
// ─────────────────────────────────────────────────────────────────────────────

export {
	basePadding,
	lineHeight,
	maxLines,
	maxHeight,
	DEFAULT_PAGE_LIMIT,
	MAX_CLIENT_PAGE_LIMIT,
	getContactPreviewText,
	initChat,
} from "./chat-state.js";

export { nearBottom, nearTop, scrollChatToBottom, scrollChatToBottomAfterPadding } from "./chat-scroll.js";

export { canLoadOlder, loadOlderMessages, clearOpenSuppression } from "./chat-paging.js";

export {
	getPinnedData,
	updatePinnedData,
	updatePinCount,
	updatePinnedMessage,
	scrollToPinnedMessage,
} from "./chat-pinned.js";

export { openChat, closeChat, resetInput } from "./chat-open.js";

export { injectMessages } from "./chat-render.js";

export { receiveMessage, handleOnetimeDeleted, handleMessagesSeen } from "./chat-receive.js";

export { sendMessage, sendOneTimeMessage, sendTimeCapsuleMessage } from "./chat-send.js";

export { handleCapsuleOpened } from "./chat-capsule.js";
