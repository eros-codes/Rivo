import { getCurrentUserId } from "./user.js";

export function safeSrc(url) {
  const defaultLight = "/assets/images/profile-light.JPG";
  const defaultDark = "/assets/images/profile-dark.JPG";
  const isDark =
    typeof document !== "undefined" &&
    document.body &&
    document.body.classList.contains("dark-mode");
  const fallback = isDark ? defaultDark : defaultLight;

  if (!url) return fallback;
  const u = String(url).trim();

  // map any placeholder/profile image names to the themed fallback
  if (/\/profile(?:-light|-dark)?\.(?:jpe?g|png|webp)$/i.test(u)) {
    return fallback;
  }

  // allow only safe image data URIs; SVG data URIs are intentionally rejected
  // because they can contain scripts and are unsafe if ever rendered outside <img>.
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(u)) return u;
  if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("/")) return u;
  return fallback;
}

export function updateThemeImages(root = document) {
  try {
    const imgs = (root && root.querySelectorAll) ? root.querySelectorAll("img") : document.querySelectorAll("img");
    const placeholderRe = /\/profile(?:-light|-dark)?\.(?:jpe?g|png|webp)(?:[#?].*)?$/i;
    imgs.forEach((img) => {
      const srcAttr = img.getAttribute("src") || "";
      if (placeholderRe.test(srcAttr)) {
        try {
          img.src = safeSrc(srcAttr);
        } catch (e) {
          /* ignore */
        }
      }
    });
  } catch (e) {
    /* ignore */
  }
}

export function observeThemeChanges() {
  try {
    if (typeof window === "undefined" || !document || !document.body) return;
    if (window.__rivo_theme_observer_installed) return;
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "class") {
          try {
            updateThemeImages();
          } catch (e) {
            /* ignore */
          }
        }
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    window.__rivo_theme_observer_installed = true;
  } catch (e) {
    /* ignore */
  }
}

// ─── Initial-letter centring ───────────────────────────────────────────────
// The avatar box centres the font's line box, which puts Latin capitals in the
// exact middle. Persian/Arabic letters (and other non-Latin glyphs) sit very
// differently around the baseline (ر، م، ع have tails, آ is tall), so each one
// is nudged by its real ink bounds, measured once per character.
const INITIAL_FONT_WEIGHT = 600; // keep in sync with .initial-avatar in contacts.css
const _initialShiftCache = new Map(); // char -> shift in em (null = not measurable)
const _initialWaiting = new Map(); // char -> Set of spans waiting for the font
let _measureCanvas = null;

function _initialFontSpec(px) {
  let family = "";
  try {
    family = document.body ? getComputedStyle(document.body).fontFamily : "";
  } catch (e) {
    family = "";
  }
  return `${INITIAL_FONT_WEIGHT} ${px}px ${family || "Poppins, Vazirmatn, sans-serif"}`;
}

function _measureInitialShift(ch) {
  if (_initialShiftCache.has(ch)) return _initialShiftCache.get(ch);
  let shift = null;
  try {
    _measureCanvas = _measureCanvas || document.createElement("canvas");
    const ctx = _measureCanvas.getContext("2d");
    const size = 100;
    ctx.font = _initialFontSpec(size);
    const glyph = ctx.measureText(ch);
    const ref = ctx.measureText("H");
    const values = [
      glyph.actualBoundingBoxAscent,
      glyph.actualBoundingBoxDescent,
      ref.fontBoundingBoxAscent,
      ref.fontBoundingBoxDescent,
    ];
    if (values.every(Number.isFinite)) {
      // with line-height: 1 the baseline sits (ascent - descent) / 2 below the
      // middle of the box; move the glyph so the middle of its ink lands there
      const baselineBelowMiddle = (ref.fontBoundingBoxAscent - ref.fontBoundingBoxDescent) / 2;
      const inkMiddleBelowBaseline = (glyph.actualBoundingBoxDescent - glyph.actualBoundingBoxAscent) / 2;
      shift = Math.round((-(baselineBelowMiddle + inkMiddleBelowBaseline) / size) * 1000) / 1000;
      if (Math.abs(shift) > 0.5) shift = null; // nonsense metrics: leave it alone
    }
  } catch (e) {
    shift = null;
  }
  _initialShiftCache.set(ch, shift);
  return shift;
}

function _applyInitialShift(span, ch) {
  const shift = _measureInitialShift(ch);
  span.style.transform = shift ? `translateY(${shift}em)` : "";
}

function _createInitialChar(ch) {
  const span = document.createElement("span");
  span.className = "initial-avatar-char";
  span.textContent = ch;
  // Persian/Arabic letters look lighter than the bold Latin capitals at the
  // same font-size; contacts.css gives them a slightly larger size
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(ch))
    span.classList.add("initial-avatar-char--arabic");
  // Latin capitals and digits are already centred by the box itself
  if (/^[A-Z0-9?]$/.test(ch)) return span;

  const fonts = document.fonts;
  const spec = _initialFontSpec(100);
  let ready = true;
  try {
    ready = !fonts || fonts.check(spec, ch);
  } catch (e) {
    ready = true;
  }
  if (ready) {
    _applyInitialShift(span, ch);
    return span;
  }
  // the (Persian) web font is not loaded yet: measure once it is
  let waiting = _initialWaiting.get(ch);
  if (!waiting) {
    waiting = new Set();
    _initialWaiting.set(ch, waiting);
    fonts
      .load(spec, ch)
      .catch(() => {})
      .then(() => {
        _initialShiftCache.delete(ch);
        const spans = _initialWaiting.get(ch) || new Set();
        _initialWaiting.delete(ch);
        spans.forEach((s) => _applyInitialShift(s, ch));
      });
  }
  waiting.add(span);
  return span;
}

export function createAvatarElement({ name, nickname, profilePics, className = "contact-profile", isOnline = false, isDeleted = false } = {}) {
  if (typeof document === "undefined") return null;

  const displayName = (nickname || name || "").trim();
  // Array.from keeps emoji / surrogate pairs whole (displayName[0] would cut them in half)
  const initial = displayName ? Array.from(displayName)[0].toUpperCase() : "?";
  // Treat the server-provided deletion flag as authoritative; relying on the
  // visible display name would let anyone spoof the deleted-account styling.
  const isDeletedAccount = isDeleted === true;

  // Determine whether a real profile picture was provided. Treat known
  // placeholder filenames (profile-light/profile-dark) as "no picture"
  // so the deterministic gradient fallback is used instead.
  const picRaw = profilePics && profilePics[0] ? String(profilePics[0]).trim() : "";
  const isPlaceholderPic = picRaw && /\/profile(?:-light|-dark)?\.(?:jpe?g|png|webp)(?:[#?].*)?$/i.test(picRaw);
  const hasPic = picRaw && !isPlaceholderPic;

  if (hasPic) {
    const img = document.createElement("img");
    img.className = `${className} ${isOnline ? "online-contact" : ""}`.trim();
    img.src = safeSrc(picRaw);
    img.alt = "Profile";
    return img;
  }

  const div = document.createElement("div");
  div.className = `${className} initial-avatar ${isOnline ? "online-contact" : ""}`.trim();
  // For deleted accounts we want only the accent color (no initial letter)
  div.textContent = "";
  if (!isDeletedAccount) div.appendChild(_createInitialChar(initial));

  // deterministic accent gradient based on name
  const grads = [
    ["#fa5f1a", "#ff8c42"],
    ["#9b59b6", "#8e44ad"],
    ["#3498db", "#2980b9"],
    ["#2ecc71", "#27ae60"],
    ["#f1c40f", "#f39c12"],
    ["#e74c3c", "#c0392b"],
    ["#1abc9c", "#16a085"],
    ["#95a5a6", "#7f8c8d"],
  ];
  let seed = 0;
  for (let i = 0; i < displayName.length; i++) seed += displayName.charCodeAt(i);

  // SVG data-URI generation removed — avatar accent is handled via CSS classes

  // Choose an accent class deterministically and add it to the element.
  // This avoids setting any background-image inline and keeps styles
  // fully in CSS as you requested.
  const accentIndex = seed % grads.length;
  div.classList.add(`initial-accent-${accentIndex}`);
  if (isDeletedAccount) div.classList.add('deleted-account-avatar');

  return div;
}

/**
 * Refresh the logged-in user's OWN avatar (the edit-profile picture) after
 * their profile changed.
 *
 * Avatars of contacts are not touched here: their cards carry the Contact row
 * id in `data-user-id`, not the account id, so looking them up by `user.id`
 * hit unrelated cards (and `img[src*="/user-profiles/7"]` also matched 70, 71…).
 * Contact avatars are rebuilt from data by the `user:updated` handler instead.
 */
export function refreshUserAvatars(user) {
  try {
    if (typeof document === "undefined" || !user || user.id == null) return;
    const currentUserId = getCurrentUserId();
    if (currentUserId == null || String(currentUserId) !== String(user.id)) return;

    const pics = Array.isArray(user.profilePics) ? user.profilePics : [];
    document.querySelectorAll(".edit-profile-avatar-wrapper").forEach((wrapper) => {
      mountAvatar(wrapper, {
        // the letter comes from the name, as other people see it
        name: user.name || user.username || "",
        nickname: "",
        // the file keeps its URL when re-uploaded: add a version so the new
        // picture is loaded instead of the cached one
        profilePics: pics.map((p) =>
          typeof p === "string" && p.startsWith("/assets/images/user-profiles/")
            ? `${p.split("?")[0]}?v=${Date.now()}`
            : p,
        ),
        className: "edit-profile-avatar",
      });
    });
  } catch (e) {
    /* ignore overall failures */
  }
}

export function mountAvatar(containerOrImg, { name, nickname, profilePics, className = "contact-profile", isOnline = false, isDeleted = false } = {}) {
  if (typeof document === "undefined" || !containerOrImg) return null;

  // If caller passed the <img> element itself, replace it with the avatar element
  // Treat explicit <img> or existing avatar-like element (initial-avatar, contact-profile,
  // chat-profile-picture, notif-avatar, active-chat-profile) as a replace target.
  const isImg = containerOrImg.tagName && containerOrImg.tagName.toLowerCase() === "img";
  const elClassList = containerOrImg.classList || [];
  const isAvatarLike = elClassList.contains && (
    elClassList.contains('initial-avatar') ||
    elClassList.contains('contact-profile') ||
    elClassList.contains('chat-profile-picture') ||
    elClassList.contains('notif-avatar') ||
    elClassList.contains('active-chat-profile') ||
    elClassList.contains('edit-profile-avatar')
  );

  // If the caller passed an <img> or an existing avatar-like element, we may be
  // operating inside a wrapper that previously displayed the "saved" icon.
  // Ensure any saved-icon decoration is removed from the wrapper before
  // inserting a real avatar so the header border/color styles don't leak.
  try {
    const wrapper = isImg ? containerOrImg.parentElement : containerOrImg;
    if (wrapper && wrapper.classList && wrapper.classList.contains('saved-icon')) {
      wrapper.classList.remove('saved-icon');
      const existingSaved = wrapper.querySelector('.saved-icon-svg');
      if (existingSaved) existingSaved.remove();
      // If an inner avatar node was hidden via inline style earlier, restore it
      try {
        const hidden = wrapper.querySelector('img[style*="display: none"], .contact-profile[style*="display: none"], .initial-avatar[style*="display: none"]');
        if (hidden && hidden.style) hidden.style.display = '';
      } catch (e) {
        /* ignore */
      }
    }
  } catch (e) {
    /* ignore wrapper cleanup errors */
  }

  if (isImg || isAvatarLike) {
    try {
      const avatar = createAvatarElement({ name, nickname, profilePics, className, isOnline, isDeleted });
      if (!avatar) return null;
      containerOrImg.replaceWith(avatar);
      return avatar;
    } catch (e) {
      return null;
    }
  }

  // Otherwise treat as a container element (e.g., span.chat-profile)
  const container = containerOrImg;
  try {
    const avatar = createAvatarElement({ name, nickname, profilePics, className, isOnline, isDeleted });
    if (!avatar) return null;

    // Find existing avatar-like element inside the container and replace it
    const existing = container.querySelector(
      "img, .initial-avatar, .contact-profile, .chat-profile-picture, .notif-avatar, .active-chat-profile"
    );
    if (existing) {
      existing.replaceWith(avatar);
    } else {
      // Prefer inserting before a button if present (edit-profile wrapper)
      const btn = container.querySelector("button");
      if (btn) container.insertBefore(avatar, btn);
      else container.insertBefore(avatar, container.firstChild);
    }
    return avatar;
  } catch (e) {
    return null;
  }
}
