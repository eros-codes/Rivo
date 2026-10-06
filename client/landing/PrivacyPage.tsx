// What Rivo stores, why, and what it never does — matching what the app and
// the server actually do.
import { Cursor } from "./LandingPage";

export function PrivacyPage() {
	return (
		<>
			<Cursor />
			<nav className="privacy-nav" aria-label="Main">
				<div className="nav-logo">
					Rivo<span>.</span>
				</div>
				<a href="/" className="nav-cta">
					← Home
				</a>
			</nav>

			<header className="privacy-hero">
				<div className="privacy-content" style={{ paddingTop: 0 }}>
					<div className="privacy-hero-label">Legal</div>
					<h1>Privacy Policy</h1>
					<p className="updated">Last updated: October 4, 2026</p>
				</div>
			</header>

			<main className="privacy-content">
				<p className="privacy-intro">
					Rivo is built on the belief that your conversations are yours. This page explains what we store, why, and how we protect it — in plain language, not
					legalese.
				</p>

				<section className="privacy-section">
					<h2>What we collect</h2>
					<ul>
						<li>Account information you provide — name, email address, username and, if you add them, a bio and a profile picture.</li>
						<li>Your messages and the details needed to deliver them (who sent what, to which chat, and when), stored encrypted.</li>
						<li>
							The devices you are signed in on: when each one signed in and was last active, and its browser&apos;s description (such as &ldquo;Chrome on
							Android&rdquo;), so you can see them and sign them out in Settings.
						</li>
						<li>Notification addresses for the devices where you turn on notifications, used only to deliver message notifications.</li>
						<li>Error reports from our servers to fix problems. They never include the content of your messages.</li>
					</ul>
				</section>

				<section className="privacy-section">
					<h2>What stays on your device</h2>
					<p>
						Your theme, accent color and chat background are kept only in your browser, as are messages waiting to be sent while you are offline. Signing out
						removes the account&apos;s data from the device.
					</p>
				</section>

				<section className="privacy-section">
					<h2>How we use data</h2>
					<p>
						We use your data to run the service: to sign you in, deliver your messages and notifications, and keep your account secure. We do not sell your
						data, use it for advertising, or share it with third parties except where required by law.
					</p>
				</section>

				<section className="privacy-section">
					<h2>Security</h2>
					<p>
						Every message is encrypted with its own unique key before it is stored (envelope encryption: per-message keys, themselves encrypted with master
						keys that are kept apart from the database). The server decrypts a message only to deliver it to the people in the conversation — Rivo is not
						end-to-end encrypted. Accounts are protected by bcrypt-hashed passwords, signed sessions in HttpOnly cookies that you can end from any device,
						CSRF protection and rate limiting.
					</p>
				</section>

				<section className="privacy-section">
					<h2>This website</h2>
					<p>
						Neither the Rivo app nor these public pages (the home page and this one) load anything from other companies: the typefaces, icons and
						scripts all come from Rivo&apos;s own server, so opening them tells no one else that you did.
					</p>
				</section>

				<section className="privacy-section">
					<h2>Your choices</h2>
					<p>
						You control who sees your online status, email address and profile picture in Settings: everyone, your contacts (people you added, wrote
						to or named yourself — not just anyone who added you) or nobody. Your email address is shown to your contacts only unless you choose
						otherwise. You can delete your account there at any time. Deleting it removes your profile, contacts, notification addresses and your
						Saved Messages; the people you talked with keep their copy of your conversations, shown
						as &ldquo;Deleted account&rdquo;. For questions or a copy of your data, contact us at <a href="mailto:privacy@rivo.ir">privacy@rivo.ir</a>.
					</p>
				</section>

				<div className="privacy-disclaimer">
					This is a plain-language summary intended for the Rivo demo site. For complete legal terms, this page should be replaced with a full privacy policy
					reviewed by qualified legal counsel before any production launch.
				</div>

				<a href="/" className="privacy-back">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M19 12H5M12 5l-7 7 7 7" />
					</svg>
					Back to Rivo
				</a>
			</main>

			<footer className="privacy-footer">
				<p>
					© 2026 <span>Rivo</span> — Conversations, Uninterrupted.
				</p>
			</footer>
		</>
	);
}
