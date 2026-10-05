// rivo.ir: what Rivo is, with a small working demo of the app. Rendered to
// HTML at build time and brought to life in the browser.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCustomCursor, useParallax, useScrollReveal, useScrolledPast, useTilt } from "./effects";

const APP = "/chat/";

// ─── The demo phone ───────────────────────────────────────────────────────

interface DemoChat {
	name: string;
	initial: string;
	status: string;
	color: string;
	msgs: { out: boolean; text: string }[];
}

const DEMO: DemoChat[] = [
	{
		name: "Rivo",
		initial: "R",
		status: "Interactive Demo",
		color: "linear-gradient(135deg,#fa5f1a,#ff8c42)",
		msgs: [
			{ out: false, text: "Hey 👋 Welcome to Rivo." },
			{ out: false, text: "This is a live demo — everything works here." },
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

function PhoneMock() {
	// the welcome chat is open at first
	const [open, setOpen] = useState<number | null>(0);
	const [leaving, setLeaving] = useState(false);
	const msgs = useRef<HTMLDivElement>(null);
	const chat = DEMO[open ?? 0]!;

	useEffect(() => {
		if (msgs.current) msgs.current.scrollTop = msgs.current.scrollHeight;
	}, [open]);

	useEffect(() => {
		if (!leaving) return undefined;
		const t = window.setTimeout(() => setLeaving(false), 320);
		return () => window.clearTimeout(t);
	}, [leaving]);

	const openChat = (i: number) => {
		setLeaving(true);
		setOpen(i);
	};

	const mainClass = `pm-screen${open === null ? " active" : leaving ? " slide-out" : ""}`;
	return (
		<div className="phone-mock" aria-label="A demo of the Rivo app">
			<div className={mainClass} aria-hidden={open !== null} inert={open !== null}>
				<div className="pm-main-header">
					<div className="pm-main-logo">
						Rivo<span>.</span>
					</div>
					<div className="pm-main-icons" aria-hidden="true">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<circle cx="11" cy="11" r="8" />
							<line x1="21" y1="21" x2="16.65" y2="16.65" />
						</svg>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
							<circle cx="9" cy="7" r="4" />
							<line x1="19" y1="8" x2="19" y2="14" />
							<line x1="22" y1="11" x2="16" y2="11" />
						</svg>
					</div>
				</div>

				<p className="pm-section-label">ACTIVE CHATS</p>
				<div className="pm-active-list">
					{[
						{ i: 1, msg: "Clean. Ship it.", time: "09:27", badge: 3 },
						{ i: 2, msg: "Right? No bloat, just what you need.", time: "10:15", badge: 2 },
					].map(({ i, msg, time, badge }) => (
						<button key={i} type="button" className="pm-active-card" onClick={() => openChat(i)}>
							<span className="pm-ac-avatar" style={{ background: DEMO[i]!.color }}>
								{DEMO[i]!.initial}
							</span>
							<span className="pm-ac-info">
								<span className="pm-ac-name">{DEMO[i]!.name}</span>
								<span className="pm-ac-msg">{msg}</span>
							</span>
							<span className="pm-ac-meta">
								<span className="pm-ac-time">{time}</span>
								<span className="pm-ac-badge">{badge}</span>
							</span>
						</button>
					))}
				</div>

				<p className="pm-section-label">CONTACTS</p>
				<div className="pm-contacts-grid">
					{[3, 4, 0].map((i) => (
						<button key={i} type="button" className="pm-contact-card" onClick={() => openChat(i)}>
							<span className="pm-cc-avatar" style={{ background: DEMO[i]!.color }}>
								{DEMO[i]!.initial}
							</span>
							<span className="pm-cc-name">{DEMO[i]!.name}</span>
							<span className="pm-cc-status">{DEMO[i]!.status}</span>
						</button>
					))}
				</div>
			</div>

			<div className={`pm-screen${open !== null ? " active" : ""}`} id="pmScreenChat" aria-hidden={open === null} inert={open === null}>
				<div className="phone-header">
					<button type="button" className="pm-back-btn" aria-label="Back to chats" onClick={() => setOpen(null)}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
							<path d="M15 18l-6-6 6-6" />
						</svg>
					</button>
					<div className="phone-avatar" style={{ background: chat.color }}>
						{chat.initial}
					</div>
					<div>
						<div className="phone-name">{chat.name}</div>
						<div className="phone-status">{chat.status}</div>
					</div>
				</div>
				<div className="phone-msgs" ref={msgs}>
					{chat.msgs.map((m, i) => (
						<div key={`${open}-${i}`} className={`pm pm-${m.out ? "out" : "in"}`}>
							<p className="pm-text">{m.text}</p>
						</div>
					))}
				</div>
				<div className="phone-input" aria-hidden="true">
					<span>Message…</span>
					<div className="phone-send">
						<svg width="10" height="10" viewBox="0 0 24 24" fill="white">
							<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
						</svg>
					</div>
				</div>
			</div>
		</div>
	);
}

// ─── Pieces ───────────────────────────────────────────────────────────────

function Arrow() {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M5 12h14M12 5l7 7-7 7" />
		</svg>
	);
}

export function Cursor() {
	const dot = useRef<HTMLDivElement>(null);
	const ring = useRef<HTMLDivElement>(null);
	useCustomCursor(dot, ring);
	return (
		<>
			<div className="cursor" ref={dot} aria-hidden="true" />
			<div className="cursor-ring" ref={ring} aria-hidden="true" />
		</>
	);
}

const SECTIONS = [
	["#home", "Home"],
	["#about", "About"],
	["#features", "Features"],
	["#download", "Download"],
] as const;

function Nav() {
	const scrolled = useScrolledPast(60);
	const [menu, setMenu] = useState(false);

	useEffect(() => {
		if (!menu) return undefined;
		document.body.style.overflow = "hidden";
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setMenu(false);
		};
		document.addEventListener("keydown", onKey);
		return () => {
			document.body.style.overflow = "";
			document.removeEventListener("keydown", onKey);
		};
	}, [menu]);

	return (
		<>
			<nav className={`nav${scrolled ? " scrolled" : ""}`} aria-label="Main">
				<div className="nav-logo">
					Rivo<span>.</span>
				</div>
				<ul className="nav-links">
					{SECTIONS.map(([href, label]) => (
						<li key={href}>
							<a href={href}>{label}</a>
						</li>
					))}
				</ul>
				<a href={APP} className="nav-cta">
					Get the App
				</a>
				<button type="button" className="nav-burger" aria-label="Menu" aria-expanded={menu} aria-controls="mobileNav" onClick={() => setMenu((v) => !v)}>
					<span />
					<span />
					<span />
				</button>
			</nav>

			<div
				className={`nav-mobile${menu ? " open" : ""}`}
				id="mobileNav"
				onClick={(e) => {
					if (e.target === e.currentTarget) setMenu(false);
				}}
			>
				<button type="button" className="nav-mobile-close" aria-label="Close menu" onClick={() => setMenu(false)}>
					✕
				</button>
				{SECTIONS.map(([href, label]) => (
					<a key={href} href={href} className="mobile-link" onClick={() => setMenu(false)}>
						{label}
					</a>
				))}
				<a href={APP} className="btn-primary" style={{ marginTop: "1rem" }}>
					Get the App
				</a>
			</div>
		</>
	);
}

function Hero() {
	const hero = useRef<HTMLElement>(null);
	const scene = useRef<HTMLDivElement>(null);
	const cluster = useRef<HTMLDivElement>(null);
	useParallax(hero);
	useTilt(scene, cluster);
	return (
		<section className="hero" id="home" ref={hero}>
			<div className="hero-bg" aria-hidden="true">
				<div className="blob blob-1" />
				<div className="blob blob-2" />
				<div className="blob blob-3" />
			</div>
			<div className="hero-bg-text" aria-hidden="true">
				RIVO
			</div>

			<div className="hero-content">
				<h1 className="hero-title">
					<span className="line">Conversations,</span>
					<span className="line line-orange">Uninterrupted.</span>
				</h1>
				<p className="hero-sub">
					A messaging app designed with intention — fast, warm, and genuinely different. Real-time, secure, and built to feel like nothing else.
				</p>
				<div className="hero-actions">
					<a href={APP} className="btn-primary">
						Get the App
						<Arrow />
					</a>
					<a href="#about" className="btn-ghost">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="10" />
							<path d="M12 8v4m0 4h.01" />
						</svg>
						Learn More
					</a>
				</div>
			</div>

			<div className="hero-visual" aria-hidden="true">
				<div className="chat-scene" ref={scene}>
					<div className="chat-float">
						<div className="chat-cluster" ref={cluster}>
							<div className="bubble bubble-orange b1">
								<p className="bubble-text">Coffee on me later ☕</p>
								<div className="bubble-meta">
									09:27
									<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
										<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
									</svg>
								</div>
							</div>
							<div className="bubble bubble-white b2">
								<div className="bubble-line" style={{ width: "100%" }} />
								<div className="bubble-line" style={{ width: "75%" }} />
								<div className="bubble-meta" style={{ marginTop: ".4rem" }}>
									09:22
								</div>
							</div>
							<div className="bubble bubble-orange b3">
								<p className="bubble-text">Way better than the last version.</p>
								<div className="bubble-meta">09:21</div>
							</div>
							<div className="scene-orb orb-1" />
							<div className="scene-orb orb-2" />
							<div className="scene-orb orb-3" />
						</div>
					</div>
					<div className="scene-glow" />
				</div>
			</div>
		</section>
	);
}

function About() {
	return (
		<section className="about" id="about">
			<div className="about-text reveal-left">
				<span className="section-label">About Rivo</span>
				<h2 className="section-title">
					Built different.
					<br />
					Feels different.
				</h2>
				<p className="section-sub">
					Most chat apps treat design as an afterthought. Rivo doesn&apos;t. Every pixel, every interaction, every animation was obsessed over — from the warm cream
					background to the glassmorphism active-chat cards. It&apos;s not just how it looks. It&apos;s how it{" "}
					<em style={{ color: "var(--orange)", fontStyle: "normal" }}>feels</em>.
				</p>
				<div className="about-stats">
					<div className="stat-card">
						<div className="stat-value">0</div>
						<div className="stat-label">Ads, Ever</div>
					</div>
					<div className="stat-card">
						<div className="stat-value">∞</div>
						<div className="stat-label">Message History</div>
					</div>
				</div>
			</div>

			<div className="about-visual reveal-right">
				<div className="about-glow" aria-hidden="true" />
				<div className="about-ring ring-1" aria-hidden="true" />
				<div className="about-ring ring-2" aria-hidden="true" />
				<PhoneMock />
			</div>
		</section>
	);
}

function Feature({ className = "", icon, title, children }: { className?: string; icon: ReactNode; title: string; children: ReactNode }) {
	return (
		<div className={`bcard reveal-scale${className ? ` ${className}` : ""}`}>
			{className.includes("featured") && <div className="bcard-accent" />}
			<div className="bcard-icon" aria-hidden="true">
				{icon}
			</div>
			<h3 className="bcard-title">{title}</h3>
			<p className="bcard-desc">{children}</p>
		</div>
	);
}

function Features() {
	return (
		<section className="features" id="features">
			<div className="features-header reveal">
				<span className="section-label">Features</span>
				<h2 className="section-title">
					Everything you need.
					<br />
					Nothing you don&apos;t.
				</h2>
				<p className="section-sub">Thoughtfully designed features that just work — no noise, no bloat.</p>
			</div>

			<div className="bento">
				<Feature
					className="featured"
					title="The Interface Other Apps Forgot to Build"
					icon={
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
							<rect x="4" y="3" width="16" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" />
							<path d="M6.5 6h5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
							<circle cx="17.5" cy="6" r="1" fill="currentColor" opacity="0.6" />
							<rect x="2" y="10.5" width="20" height="5" rx="2.5" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity="0.09" />
							<path d="M5 13h10" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" opacity="0.38" />
							<rect x="4" y="17" width="16" height="5" rx="2" stroke="currentColor" strokeWidth="1.4" fill="currentColor" fillOpacity="0.04" />
							<path d="M6.5 19.5h7" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" opacity="0.25" />
						</svg>
					}
				>
					Every surface was argued over. Frosted glass, layered shadows, gradients that guide before you notice them — nothing here is default. Every other app
					drowns you in one endless list of contacts. Rivo knows the difference between a conversation that&apos;s alive and one that went quiet — so it
					separates them. Active chats surface. Dormant contacts stay tucked away. Every transition has a reason. Every detail was deliberate. This isn&apos;t just
					a UI. It&apos;s an opinion.
				</Feature>

				<Feature
					title="The Full Package."
					icon={
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
							<path d="M12 2L2 7v10l10 5 10-5V7L12 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
							<path d="M2 7l10 5 10-5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
							<path d="M12 12v10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.28" />
							<path d="M9 8.5l2 2.2 4.5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" opacity="0.75" />
						</svg>
					}
				>
					Search. React. Pin. Archive. Forward. Mute. Everything a serious messenger should do — running quietly in the background, so you never have to think
					twice about it.
				</Feature>

				<Feature
					title="Security First"
					icon={
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
						</svg>
					}
				>
					Signed sessions you can see and end from any device, CSRF protection, rate limiting, and bcrypt-hashed passwords. Every layer hardened.
				</Feature>

				<Feature
					className="wide"
					title="Encrypted where it's stored"
					icon={
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<rect x="3" y="11" width="18" height="10" rx="2" />
							<path d="M7 11V7a5 5 0 0 1 10 0v4" />
							<circle cx="12" cy="16" r="1.5" />
						</svg>
					}
				>
					Every message is encrypted with its own unique key before it is saved. The keys that protect those keys are kept apart from the database — so a copy of
					the database alone reveals nothing.
				</Feature>

				<Feature
					className="wide"
					title="Beyond Send"
					icon={
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
							<path
								d="M4 4.5A1.5 1.5 0 015.5 3h13A1.5 1.5 0 0120 4.5v10A1.5 1.5 0 0118.5 16H9.5L6 20V16H5.5A1.5 1.5 0 014 14.5V4.5z"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinejoin="round"
							/>
							<circle cx="12" cy="9" r="3.5" stroke="currentColor" strokeWidth="1.3" />
							<path d="M12 7.5V9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
							<path d="M12 9l1.9 1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
							<circle cx="12" cy="9" r="0.5" fill="currentColor" />
						</svg>
					}
				>
					One-time messages that vanish the moment they&apos;re read. Time Capsules sealed until a date you choose, then opened right on time. Rivo gives your
					words a timeline — and a life — of their own.
				</Feature>

				<Feature
					title="Find Anything"
					icon={
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<circle cx="11" cy="11" r="7" />
							<path d="m21 21-4.35-4.35" />
						</svg>
					}
				>
					One search box for people and conversations. Type a few letters and jump straight to the message you meant — highlighted, right where it was said.
				</Feature>

				<Feature
					title="PWA Ready"
					icon={
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
							<line x1="12" y1="18" x2="12.01" y2="18" />
						</svg>
					}
				>
					Install once, use everywhere. No app store required — just open and add to home screen.
				</Feature>
			</div>
		</section>
	);
}

function Download() {
	return (
		<section className="download" id="download">
			<div className="download-header reveal">
				<span className="section-label">Get Rivo</span>
				<h2 className="section-title">
					Three steps.
					<br />
					That&apos;s all.
				</h2>
				<p className="section-sub">No app store. No download. Just open it in your browser and make it yours in seconds.</p>
			</div>

			<ol className="pwa-steps">
				<li className="step reveal-scale">
					<div className="step-num">1</div>
					<h3 className="step-title">Open in Browser</h3>
					<p className="step-desc">Visit the Rivo web app in Chrome, Safari, or any modern browser on any device.</p>
				</li>
				<li className="step reveal-scale">
					<div className="step-num">2</div>
					<h3 className="step-title">Tap Install</h3>
					<p className="step-desc">Hit the install prompt in your browser bar or use the share menu on iOS to add to home screen.</p>
				</li>
				<li className="step reveal-scale">
					<div className="step-num">3</div>
					<h3 className="step-title">Start Chatting</h3>
					<p className="step-desc">Launch it from your home screen just like a native app — with notifications for new messages.</p>
				</li>
			</ol>

			<div className="download-cta-wrap reveal">
				<a href={APP} className="btn-primary" style={{ fontSize: "1rem", padding: "1rem 2.5rem" }}>
					Open Rivo Web App
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
					</svg>
				</a>
			</div>
		</section>
	);
}

export function LandingPage() {
	const root = useRef<HTMLDivElement>(null);
	useScrollReveal(root);
	return (
		<div ref={root}>
			<Cursor />
			<Nav />
			<main>
				<Hero />
				<About />
				<Features />
				<Download />
			</main>
			<footer>
				<div className="foot-logo">
					Rivo<span>.</span>
				</div>
				<p className="foot-copy">© 2026 Rivo. Conversations, Uninterrupted.</p>
				<nav className="foot-links" aria-label="Footer">
					<a href="#home">Home</a>
					<a href="#about">About</a>
					<a href="/landing/privacy.html">Privacy Policy</a>
				</nav>
			</footer>
		</div>
	);
}
