/* ── Custom Cursor ──────────────────────────────────────────────────────── */
const cursor = document.getElementById("cursor");
const cursorRing = document.getElementById("cursorRing");
let mx = 0,
	my = 0,
	rx = 0,
	ry = 0,
	cx = 0,
	cy = 0;

// Capture raw mouse position; use a single rAF loop to update visuals for smoother rendering
document.addEventListener("mousemove", (e) => {
	mx = e.clientX;
	my = e.clientY;
});

(function renderCursor() {
	// main cursor — quick follow
	cx += (mx - cx) * 0.22;
	cy += (my - cy) * 0.22;
	if (cursor)
		cursor.style.transform = `translate3d(${cx}px, ${cy}px, 0) translate(-50%, -50%)`;

	// ring — slightly lagged for trailing effect
	rx += (mx - rx) * 0.12;
	ry += (my - ry) * 0.12;
	if (cursorRing)
		cursorRing.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%)`;

	requestAnimationFrame(renderCursor);
})();

/* ── Nav scroll ─────────────────────────────────────────────────────────── */
const nav = document.getElementById("nav");
window.addEventListener("scroll", () => {
	nav.classList.toggle("scrolled", window.scrollY > 60);
});

/* ── Mobile nav ─────────────────────────────────────────────────────────── */
const burger = document.getElementById("burger");
const mobileNav = document.getElementById("mobileNav");
const mobileClose = document.getElementById("mobileClose");
const mobileLinks = document.querySelectorAll(".mobile-link");

burger.addEventListener("click", () => {
	const isOpen = mobileNav.classList.toggle("open");
	document.body.style.overflow = isOpen ? "hidden" : "";
	burger.setAttribute("aria-expanded", isOpen ? "true" : "false");
});
function closeMob() {
	mobileNav.classList.remove("open");
	document.body.style.overflow = "";
	burger.setAttribute("aria-expanded", "false");
}
mobileClose.addEventListener("click", closeMob);
mobileLinks.forEach((l) => l.addEventListener("click", closeMob));

// close when clicking the overlay (outside the menu) or pressing Escape
mobileNav.addEventListener("click", (e) => {
	if (e.target === mobileNav) closeMob();
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") closeMob();
});

/* ── 3D Chat bubble mouse parallax ─────────────────────────────────────── */
const chatScene = document.getElementById("chatScene");
const chatCluster = document.getElementById("chatCluster");
let targetRX = 0,
	targetRY = 0,
	currentRX = 0,
	currentRY = 0;
let chatCX = 0,
	chatCY = 0,
	chatCW = 0,
	chatCH = 0;

// Limits for how far the scene can tilt (degrees)
const MAX_TILT_X = 15; // up / down (reduced for gentler motion)
const MAX_TILT_Y = 15; // left / right (reduced for gentler motion)

function clamp(v, a, b) {
	return Math.max(a, Math.min(b, v));
}

function updateChatCenter() {
	if (!chatScene) return;
	const rect = chatScene.getBoundingClientRect();
	chatCX = rect.left + rect.width / 2;
	chatCY = rect.top + rect.height / 2;
	chatCW = rect.width || window.innerWidth;
	chatCH = rect.height || window.innerHeight;
}

updateChatCenter();
window.addEventListener("resize", updateChatCenter, { passive: true });
window.addEventListener("scroll", updateChatCenter, { passive: true });

document.addEventListener("mousemove", (e) => {
	if (!chatScene) return;
	const normW = chatCW * 0.5 || window.innerWidth * 0.5;
	const normH = chatCH * 0.5 || window.innerHeight * 0.5;
	const dx = (e.clientX - chatCX) / normW;
	const dy = (e.clientY - chatCY) / normH;

	// compute target angles and clamp to configured limits
	targetRY = clamp(dx * MAX_TILT_Y, -MAX_TILT_Y, MAX_TILT_Y);
	targetRX = clamp(-dy * MAX_TILT_X, -MAX_TILT_X, MAX_TILT_X);
});

(function animCluster() {
	currentRX += (targetRX - currentRX) * 0.06;
	currentRY += (targetRY - currentRY) * 0.06;
	// ensure applied values are clamped (avoid accidental overshoot/inversion)
	const appliedRX = clamp(currentRX, -MAX_TILT_X, MAX_TILT_X);
	const appliedRY = clamp(currentRY, -MAX_TILT_Y, MAX_TILT_Y);
	if (chatCluster)
		chatCluster.style.transform = `rotateX(${appliedRX}deg) rotateY(${appliedRY}deg)`;
	requestAnimationFrame(animCluster);
})();

/* ── GSAP Animations ────────────────────────────────────────────────────── */
gsap.registerPlugin(ScrollTrigger);

// Hero entrance
const heroTL = gsap.timeline({ defaults: { ease: "power3.out" } });
heroTL
	.from(
		".hero-title .line",
		{ opacity: 0, y: 50, duration: 0.9, stagger: 0.15 },
		0.4,
	)
	.from(".hero-sub", { opacity: 0, y: 25, duration: 0.7 }, 0.8)
	.from(".hero-actions", { opacity: 0, y: 25, duration: 0.7 }, 1.0)
	.from(
		".chat-scene",
		{ opacity: 0, x: 80, scale: 0.9, duration: 1.2, ease: "power2.out" },
		0.3,
	);

// Reveal utility
function reveal(selector, extras = {}) {
	document.querySelectorAll(selector).forEach((el, i) => {
		const fromLeft = el.classList.contains("reveal-left");
		const fromRight = el.classList.contains("reveal-right");
		const fromScale = el.classList.contains("reveal-scale");
		gsap.from(el, {
			scrollTrigger: {
				trigger: el,
				start: "top 85%",
				toggleActions: "play none none none",
			},
			opacity: 0,
			x: fromLeft ? -50 : fromRight ? 50 : 0,
			y: !fromLeft && !fromRight && !fromScale ? 40 : 0,
			scale: fromScale ? 0.88 : 1,
			duration: 0.75,
			delay: i * 0.06,
			ease: "power2.out",
			...extras,
		});
	});
}
reveal(".reveal");
reveal(".reveal-left");
reveal(".reveal-right");
reveal(".reveal-scale");

// Bento cards stagger
gsap.from(".bcard", {
	scrollTrigger: { trigger: ".bento", start: "top 95%" },
	opacity: 0,
	scale: 0.87,
	y: 30,
	duration: 0.45,
	stagger: 0.05,
	ease: "power2.out",
});

// Stats count-up
const stats = document.querySelectorAll(".stat-value");
stats.forEach((el) => {
	const text = el.textContent;
	const num = parseFloat(text);
	if (isNaN(num)) return;
	const suffix = text.replace(/[\d.]/g, "");
	gsap.from(
		{ val: 0 },
		{
			scrollTrigger: { trigger: el, start: "top 85%" },
			val: num,
			duration: 1.5,
			ease: "power2.out",
			onUpdate() {
				el.innerHTML =
					Math.round(this.targets()[0].val) +
					"<span>" +
					suffix +
					"</span>";
			},
		},
	);
});

// Smooth hover on bento cards
document.querySelectorAll(".bcard").forEach((card) => {
	card.addEventListener("mouseenter", (e) => {
		gsap.to(card, { scale: 1.02, duration: 0.25, ease: "power2.out" });
	});
	card.addEventListener("mouseleave", (e) => {
		gsap.to(card, { scale: 1, duration: 0.25, ease: "power2.out" });
	});
});

// Download steps entrance
gsap.from(".step", {
	scrollTrigger: { trigger: ".pwa-steps", start: "top 95%" },
	opacity: 0,
	y: 40,
	scale: 0.92,
	duration: 0.45,
	stagger: 0.1,
	ease: "power2.out",
});

// Parallax on hero blobs
gsap.to(".blob-1", {
	scrollTrigger: {
		trigger: ".hero",
		start: "top top",
		end: "bottom top",
		scrub: 1,
	},
	y: -80,
});
gsap.to(".blob-2", {
	scrollTrigger: {
		trigger: ".hero",
		start: "top top",
		end: "bottom top",
		scrub: 1.5,
	},
	y: -50,
});
// Phone mock content is set in HTML now; randomized JS removed.
/* ── Interactive Phone Mock ─────────────────────────────────────── */
(function initPhoneMock() {
	const mockData = [
		{
			name: "Rivo",
			initial: "R",
			status: "Interactive Demo",
			color: "linear-gradient(135deg,#fa5f1a,#ff8c42)",
			msgs: [
				{ out: false, text: "Hey 👋 Welcome to Rivo." },
				{
					out: false,
					text: "This is a live demo — everything works here.",
				},
				{ out: true, text: "Wait, I can actually interact with this?" },
				{ out: false, text: "Tap ‹ to explore chats and contacts ✨" },
			],
		},
		{
			name: "Alex",
			initial: "A",
			status: "Online now",
			color: "linear-gradient(135deg,#fa5f1a,#ff8c42)",
			msgs: [
				{ out: false, text: "Just shipped the new feature 🚀" },
				{ out: true, text: "Already? That was fast." },
				{ out: false, text: "Real-time everything — no delays." },
				{ out: true, text: "Clean. Ship it." },
			],
		},
		{
			name: "Maya",
			initial: "M",
			status: "Last seen recently",
			color: "linear-gradient(135deg,#9b59b6,#8e44ad)",
			msgs: [
				{ out: true, text: "Did you pin those messages?" },
				{ out: false, text: "Yeah, one tap and they're saved." },
				{ out: true, text: "Rivo makes this so clean honestly." },
				{ out: false, text: "Right? No bloat, just what you need." },
			],
		},
		{
			name: "Jake",
			initial: "J",
			status: "Online now",
			color: "linear-gradient(135deg,#3498db,#2980b9)",
			msgs: [
				{ out: false, text: "Archived the old threads, so clean now." },
				{ out: true, text: "Archive is a game changer ngl." },
				{ out: false, text: "And the search finds messages too 🔍" },
				{ out: true, text: "This thing just keeps getting better." },
			],
		},
		{
			name: "Sofia",
			initial: "S",
			status: "Offline",
			color: "linear-gradient(135deg,#2ecc71,#27ae60)",
			msgs: [
				{ out: true, text: "Have you tried the PWA install?" },
				{ out: false, text: "Yeah — feels like a native app." },
				{ out: true, text: "No app store, just open and install." },
				{ out: false, text: "That's the future fr 🙌" },
			],
		},
	];

	const screenMain = document.getElementById("pmScreenMain");
	const screenChat = document.getElementById("pmScreenChat");
	const pmMsgs = document.getElementById("pmMsgs");
	const pmBack = document.getElementById("pmBack");
	const pmChatName = document.getElementById("pmChatName");
	const pmChatStatus = document.getElementById("pmChatStatus");
	const pmChatAvatar = document.getElementById("pmChatAvatar");

	if (!screenMain) return;
	openChat(0); // open first chat by default

	function openChat(idx) {
		const d = mockData[idx];
		pmChatName.textContent = d.name;
		pmChatStatus.textContent = d.status;
		pmChatAvatar.textContent = d.initial;
		pmChatAvatar.style.background = d.color;

		pmMsgs.innerHTML = "";
		d.msgs.forEach((m) => {
			const div = document.createElement("div");
			div.className = "pm pm-" + (m.out ? "out" : "in");
			div.innerHTML = `<p class="pm-text">${m.text}</p>`;
			pmMsgs.appendChild(div);
		});

		if (screenMain.classList.contains("active")) {
			screenMain.classList.remove("active");
			screenMain.classList.add("slide-out");
			setTimeout(() => screenMain.classList.remove("slide-out"), 320);
		}
		screenChat.classList.add("active");

		setTimeout(() => screenMain.classList.remove("slide-out"), 320);
		pmMsgs.scrollTop = pmMsgs.scrollHeight;
	}

	function goBack() {
		screenChat.classList.remove("active");
		screenMain.classList.add("active");
	}

	document.querySelectorAll(".pm-active-card").forEach((card) => {
		card.addEventListener("click", () => openChat(+card.dataset.chat));
	});
	document.querySelectorAll(".pm-contact-card").forEach((card) => {
		card.addEventListener("click", () => openChat(+card.dataset.chat));
	});
	pmBack.addEventListener("click", goBack);
})();
