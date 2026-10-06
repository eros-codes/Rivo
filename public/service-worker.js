"use strict";
(() => {
  // <define:__SHELL_ASSETS__>
  var define_SHELL_ASSETS_default = ["/app/boot-MNXGXJFJ.js", "/app/chat-TFLFGJBN.js", "/app/chunks/chunk-QDB3USIM.js", "/app/chunks/chunk-2JMC5G3Z.js", "/app/chunks/chunk-GRWXGSY5.js", "/app/chunks/chunk-EXRSNSHP.js", "/app/chat-VLQOHN3R.css"];

  // client/sw/service-worker.ts
  var SHELL_CACHE = `rivo-shell-${"21f67d68132e"}`;
  var FONT_CACHE = "rivo-fonts-v1";
  var CHAT_PAGE = "/chat/";
  var ICON = "/assets/icons/Icon-192.png";
  self.addEventListener("install", (event) => {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        await cache.addAll(define_SHELL_ASSETS_default).catch(() => void 0);
        await cache.add(new Request(CHAT_PAGE, { cache: "reload" })).catch(() => void 0);
        await self.skipWaiting();
      })()
    );
  });
  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith("rivo-shell-") && n !== SHELL_CACHE).map((n) => caches.delete(n)));
        await self.clients.claim();
      })()
    );
  });
  async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request);
    if (hit) return hit;
    const res = await fetch(request);
    if (res.ok && res.type === "basic") await cache.put(request, res.clone()).catch(() => void 0);
    return res;
  }
  async function chatPage(request) {
    try {
      const res = await fetch(request);
      if (res.ok && res.type === "basic" && !res.redirected) {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(CHAT_PAGE, res.clone()).catch(() => void 0);
      }
      return res;
    } catch (e) {
      const kept = await caches.match(CHAT_PAGE);
      if (kept) return kept;
      throw e;
    }
  }
  self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (request.mode === "navigate" && url.pathname === CHAT_PAGE) {
      event.respondWith(chatPage(request));
      return;
    }
    if (url.pathname.startsWith("/app/")) {
      event.respondWith(cacheFirst(request, SHELL_CACHE));
      return;
    }
    if (url.pathname.startsWith("/assets/fonts/")) {
      event.respondWith(cacheFirst(request, FONT_CACHE));
    }
  });
  self.addEventListener("push", (event) => {
    let payload = {};
    try {
      const parsed = event.data?.json();
      if (parsed && typeof parsed === "object") payload = parsed;
    } catch {
      payload = { title: "Rivo", body: event.data?.text() ?? "" };
    }
    const data = payload.data && typeof payload.data === "object" ? payload.data : {};
    const tag = typeof payload.tag === "string" ? payload.tag : data.conversationId ? `conversation-${String(data.conversationId)}` : "";
    const options = {
      body: typeof payload.body === "string" ? payload.body : "",
      icon: ICON,
      badge: ICON,
      data
    };
    if (tag) {
      options.tag = tag;
      options.renotify = true;
    }
    event.waitUntil(self.registration.showNotification(typeof payload.title === "string" && payload.title ? payload.title : "Rivo", options));
  });
  var positive = (v) => {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
  };
  function targetUrl(data) {
    const conversationId = positive(data?.conversationId);
    const messageId = positive(data?.messageId);
    const url = new URL(CHAT_PAGE, self.location.origin);
    if (conversationId) url.searchParams.set("conversationId", conversationId);
    if (conversationId && messageId) url.searchParams.set("messageId", messageId);
    return url.href;
  }
  self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data ?? {};
    const target = targetUrl(data);
    event.waitUntil(
      (async () => {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const chat = windows.find((c) => {
          try {
            return new URL(c.url).pathname === CHAT_PAGE;
          } catch {
            return false;
          }
        });
        if (chat) {
          await chat.focus().catch(() => void 0);
          chat.postMessage({ type: "push:click", payload: { conversationId: positive(data?.conversationId), messageId: positive(data?.messageId) } });
          return;
        }
        const other = windows.find((c) => "navigate" in c);
        if (other) {
          const moved = await other.navigate(target).catch(() => null);
          if (moved) {
            await moved.focus().catch(() => void 0);
            return;
          }
        }
        await self.clients.openWindow(target);
      })()
    );
  });
})();
