// Placeholders shown while the lists load.

export function ContactSkeletons({ count = 6 }: { count?: number }) {
	return (
		<>
			{Array.from({ length: count }, (_, i) => (
				<span key={i} className="contacts-card skeleton-placeholder" aria-hidden="true">
					<div className="contact-profile skeleton" />
					<span className="contact-name">
						<div className="skel-line skeleton" style={{ width: `${55 + (i % 3) * 10}%` }} />
					</span>
					<span className="contact-message">
						<span className="last-message">
							<div className="skel-line skeleton" style={{ width: `${40 + (i % 3) * 12}%` }} />
						</span>
					</span>
				</span>
			))}
		</>
	);
}

export function ActiveChatSkeletons({ count = 4 }: { count?: number }) {
	return (
		<>
			{Array.from({ length: count }, (_, i) => (
				<div key={i} className="active-chat-wrapper skeleton-placeholder" aria-hidden="true">
					<div className="active-chat skeleton-placeholder">
						<div className="active-chat-profile skeleton" />
						<span className="active-chat-info">
							<span className="active-chat-name" style={{ width: "100%" }}>
								<div className="skel-line skeleton" style={{ width: `${45 + (i % 3) * 12}%` }} />
							</span>
							<span className="active-chat-last-message" style={{ width: "100%" }}>
								<div className="skel-line skeleton" style={{ width: `${30 + (i % 3) * 12}%` }} />
							</span>
						</span>
						<span className="active-chat-meta">
							<span className="active-chat-message-time skel-line skeleton" style={{ width: "40px" }} />
						</span>
					</div>
				</div>
			))}
		</>
	);
}

export function MessageSkeletons({ count = 8 }: { count?: number }) {
	return (
		<>
			{Array.from({ length: count }, (_, i) => (
				<div key={i} className={`chat-message ${i % 2 ? "outgoing" : "incoming"} skeleton-placeholder`} aria-hidden="true">
					<div className="chat-message-text skeleton skel-line" style={{ width: `${40 + (i % 4) * 12}%`, minHeight: `${20 + (i % 3) * 8}px` }} />
					<div className="chat-message-meta skeleton">
						<span className="chat-message-time skel-line skeleton" style={{ width: "36px" }} />
					</div>
				</div>
			))}
		</>
	);
}

export function TopMessageSkeleton() {
	return (
		<div className="skeleton-top skeleton-placeholder" aria-hidden="true">
			<div className="chat-message incoming skeleton-placeholder">
				<div className="chat-message-text skeleton skel-line" style={{ width: "38%", minHeight: "28px" }} />
			</div>
		</div>
	);
}
