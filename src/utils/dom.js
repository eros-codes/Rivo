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

  // allow data URIs and absolute/site-relative URLs
  if (u.startsWith("data:image/")) return u;
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

export function createAvatarElement({ name, nickname, profilePics, className = "contact-profile", isOnline = false } = {}) {
  if (typeof document === "undefined") return null;

  const displayName = (nickname || name || "").trim();
  const initial = displayName ? displayName[0].toUpperCase() : "?";

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
  div.textContent = initial;

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
  const g = grads[seed % grads.length];

  // SVG data-URI generation removed — avatar accent is handled via CSS classes

  // Choose an accent class deterministically and add it to the element.
  // This avoids setting any background-image inline and keeps styles
  // fully in CSS as you requested.
  const accentIndex = seed % grads.length;
  div.classList.add(`initial-accent-${accentIndex}`);

  return div;
}

/**
 * Refresh avatar elements across the page for a given user object.
 * Finds DOM nodes that either carry `data-user-id` or reference the
 * user's profile image URL and re-mounts the avatar element.
 */
export function refreshUserAvatars(user) {
  try {
    if (typeof document === "undefined" || !user || !user.id) return;
    const uid = String(user.id);
    const profilePics = user.profilePics || [];
    const name = user.name || "";
    const nickname = user.username || user.nickname || "";

    // Update any container that has data-user-id set to this user
    const containers = Array.from(document.querySelectorAll(`[data-user-id="${uid}"]`));
    containers.forEach((c) => {
      try {
        mountAvatar(c, {
          name,
          nickname,
          profilePics,
          // Let mountAvatar pick the internal element; className left generic
          className: "contact-profile",
          isOnline: !!user.isOnline,
        });
      } catch (e) {
        /* ignore per-element failures */
      }
    });

    // Replace any <img> that references the user's uploaded file directly
    const imgSel = `img[src*="/assets/images/user-profiles/${uid}"]`;
    const imgs = Array.from(document.querySelectorAll(imgSel));
    imgs.forEach((img) => {
      try {
        mountAvatar(img, {
          name,
          nickname,
          profilePics,
          className: img.className || "contact-profile",
          isOnline: !!user.isOnline,
        });
      } catch (e) {
        /* ignore */
      }
    });

    // Update a few common singleton targets (edit/profile header) if present
    const singleTargets = [
      ".edit-profile-avatar",
      ".chat-profile-picture",
      ".chat-profile",
      ".detail-picture img",
    ];
    singleTargets.forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      try {
        mountAvatar(el, {
          name,
          nickname,
          profilePics,
          className: el.className || "contact-profile",
          isOnline: !!user.isOnline,
        });
      } catch (e) {
        /* ignore */
      }
    });
  } catch (e) {
    /* ignore overall failures */
  }
}

export function mountAvatar(containerOrImg, { name, nickname, profilePics, className = "contact-profile", isOnline = false } = {}) {
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

  if (isImg || isAvatarLike) {
    try {
      const avatar = createAvatarElement({ name, nickname, profilePics, className, isOnline });
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
    const avatar = createAvatarElement({ name, nickname, profilePics, className, isOnline });
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
