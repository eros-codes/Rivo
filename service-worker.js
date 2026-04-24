// const CACHE_NAME = "Rivo-v1";
// const ASSETS = [
// 	"/",
// 	"/index.html",
// 	"/src/pages/auth/auth.html",
// 	"/src/pages/main/main-page.html",
// 	"/public/css/global.css",
// 	"/public/assets/icons/Icon-192.png",
// 	"/public/assets/icons/Icon-512.png",
// ];

// self.addEventListener("install", (e) => {
// 	e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
// });

// self.addEventListener("fetch", (e) => {
// 	e.respondWith(
// 		caches.match(e.request).then((cached) => cached || fetch(e.request)),
// 	);
// });
