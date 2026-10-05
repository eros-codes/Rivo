// Every icon of the app, drawn inline (no network, colored with currentColor).
import type { ReactNode } from "react";

export interface IconProps {
	size?: number;
	className?: string;
}

function make(viewBox: string, defaultSize: number, body: ReactNode) {
	function Icon({ size = defaultSize, className }: IconProps) {
		return (
			<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox={viewBox} className={className} aria-hidden="true" focusable="false">
				{body}
			</svg>
		);
	}
	return Icon;
}

const GEAR_PATH =
	"M3.082 13.945c-.529-.95-.793-1.426-.793-1.945s.264-.994.793-1.944L4.43 7.63l1.426-2.381c.559-.933.838-1.4 1.287-1.66c.45-.259.993-.267 2.08-.285L12 3.26l2.775.044c1.088.018 1.631.026 2.08.286s.73.726 1.288 1.659L19.57 7.63l1.35 2.426c.528.95.792 1.425.792 1.944s-.264.994-.793 1.944L19.57 16.37l-1.426 2.381c-.559.933-.838 1.4-1.287 1.66c-.45.259-.993.267-2.08.285L12 20.74l-2.775-.044c-1.088-.018-1.631-.026-2.08-.286s-.73-.726-1.288-1.659L4.43 16.37z";

const EDIT_PATHS = (
	<g fill="currentColor" fillRule="evenodd" clipRule="evenodd">
		<path d="M2 6.857A4.857 4.857 0 0 1 6.857 2H12a1 1 0 1 1 0 2H6.857A2.857 2.857 0 0 0 4 6.857v10.286A2.857 2.857 0 0 0 6.857 20h10.286A2.857 2.857 0 0 0 20 17.143V12a1 1 0 1 1 2 0v5.143A4.857 4.857 0 0 1 17.143 22H6.857A4.857 4.857 0 0 1 2 17.143z" />
		<path d="m15.137 13.219l-2.205 1.33l-1.033-1.713l2.205-1.33l.003-.002a1.2 1.2 0 0 0 .232-.182l5.01-5.036a3 3 0 0 0 .145-.157c.331-.386.821-1.15.228-1.746c-.501-.504-1.219-.028-1.684.381a6 6 0 0 0-.36.345l-.034.034l-4.94 4.965a1.2 1.2 0 0 0-.27.41l-.824 2.073a.2.2 0 0 0 .29.245l1.032 1.713c-1.805 1.088-3.96-.74-3.18-2.698l.825-2.072a3.2 3.2 0 0 1 .71-1.081l4.939-4.966l.029-.029c.147-.15.641-.656 1.24-1.02c.327-.197.849-.458 1.494-.508c.74-.059 1.53.174 2.15.797a2.9 2.9 0 0 1 .845 1.75a3.15 3.15 0 0 1-.23 1.517c-.29.717-.774 1.244-.987 1.457l-5.01 5.036q-.28.281-.62.487m4.453-7.126s-.004.003-.013.006z" />
	</g>
);

const PIN_STROKE_PATH =
	"M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4a1 1 0 0 1 1 1z";

const CHEVRON_LEFT =
	"M16.62 2.99a1.25 1.25 0 0 0-1.77 0L6.54 11.3a.996.996 0 0 0 0 1.41l8.31 8.31c.49.49 1.28.49 1.77 0s.49-1.28 0-1.77L9.38 12l7.25-7.25c.48-.48.48-1.28-.01-1.76";

const CLOSE_PATH = "M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12z";

const CAPSULE_LOCK = (
	<>
		<rect x="5" y="10" width="14" height="10" rx="3" stroke="currentColor" strokeWidth="1.8" fill="none" />
		<path d="M8 10V7.5C8 5.57 9.57 4 11.5 4H12.5C14.43 4 16 5.57 16 7.5V10" stroke="currentColor" strokeWidth="1.8" fill="none" />
		<circle cx="12" cy="15" r="2.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
		<path d="M12 15V13.8M12 15L13 15.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
	</>
);

const CAPSULE_UNLOCK = (
	<>
		<rect x="5" y="10" width="14" height="10" rx="3" stroke="currentColor" strokeWidth="1.8" fill="none" />
		<path d="M15.5 6.2C15.5 4.64 14.36 3.5 12.8 3.5H12.2C10.64 3.5 9.5 4.64 9.5 6.2V8" stroke="currentColor" strokeWidth="1.8" fill="none" />
		<circle cx="12" cy="15" r="2.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
		<path d="M12 15V13.8M12 15L13 15.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
	</>
);

const ONE_TIME = (
	<>
		<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray="47 10" strokeLinecap="round" strokeDashoffset="-5" />
		<text x="12" y="16.5" textAnchor="middle" fontSize="9.5" fontWeight="700" fill="currentColor">
			1
		</text>
	</>
);

export const Icons = {
	Gear: make(
		"0 0 24 24",
		24,
		<g fill="none" stroke="currentColor" strokeWidth="2">
			<path d={GEAR_PATH} />
			<circle cx="12" cy="12" r="3" />
		</g>,
	),
	Edit: make("0 0 24 24", 24, EDIT_PATHS),
	Logout: make(
		"0 0 24 24",
		24,
		<path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v1" />,
	),
	Search: make(
		"0 0 20 20",
		20,
		<path
			fill="currentColor"
			d="M12.14 4.18a5.504 5.504 0 0 1 .72 6.89c.12.1.22.21.36.31c.2.16.47.36.81.59c.34.24.56.39.66.47c.42.31.73.57.94.78c.32.32.6.65.84 1c.25.35.44.69.59 1.04c.14.35.21.68.18 1q-.03.48-.36.81c-.33.33-.49.34-.81.36c-.31.02-.65-.04-.99-.19c-.35-.14-.7-.34-1.04-.59c-.35-.24-.68-.52-1-.84c-.21-.21-.47-.52-.77-.93c-.1-.13-.25-.35-.47-.66c-.22-.32-.4-.57-.56-.78c-.16-.2-.29-.35-.44-.5a5.5 5.5 0 0 1-6.44-.98c-2.14-2.15-2.14-5.64 0-7.78a5.5 5.5 0 0 1 7.78 0m-1.41 6.36a3.513 3.513 0 0 0 0-4.95a3.495 3.495 0 0 0-4.95 0a3.495 3.495 0 0 0 0 4.95a3.495 3.495 0 0 0 4.95 0"
		/>,
	),
	SearchLine: make(
		"0 0 24 24",
		18,
		<path fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" d="m21 21l-4.34-4.34M17 11a6 6 0 1 1-12 0a6 6 0 0 1 12 0" />,
	),
	AddFriend: make(
		"0 0 24 24",
		24,
		<g fill="none" stroke="currentColor" strokeWidth="2">
			<circle cx="12" cy="7" r="5" />
			<path strokeLinecap="round" strokeLinejoin="round" d="M17 22H5.266a2 2 0 0 1-1.985-2.248l.39-3.124A3 3 0 0 1 6.649 14H7m12 0v4m-2-2h4" />
		</g>,
	),
	People: make(
		"0 0 24 24",
		48,
		<path
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="1.5"
			d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2m8-10a4 4 0 1 0 0-8a4 4 0 0 0 0 8m13 10v-2a4 4 0 0 0-3-3.87m-4-12a4 4 0 0 1 0 7.75"
		/>,
	),
	Back: make("0 0 24 24", 24, <path fill="currentColor" d={CHEVRON_LEFT} />),
	Close: make("0 0 24 24", 24, <path fill="currentColor" d={CLOSE_PATH} />),
	CloseThin: make(
		"0 0 24 24",
		24,
		<path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M6.758 17.243L12.001 12m5.243-5.243L12 12m0 0L6.758 6.757M12.001 12l5.243 5.243" />,
	),
	Check: make(
		"0 0 24 24",
		24,
		<path
			fill="currentColor"
			d="m9.55 15.15l8.475-8.475q.3-.3.7-.3t.7.3t.3.713t-.3.712l-9.175 9.2q-.3.3-.7.3t-.7-.3L4.55 13q-.3-.3-.288-.712t.313-.713t.713-.3t.712.3z"
		/>,
	),
	Dots: make(
		"0 0 24 24",
		18,
		<path fill="currentColor" d="M12 10c-1.1 0-2 .9-2 2s.9 2 2 2s2-.9 2-2s-.9-2-2-2m0-6c-1.1 0-2 .9-2 2s.9 2 2 2s2-.9 2-2s-.9-2-2-2m0 12c-1.1 0-2 .9-2 2s.9 2 2 2s2-.9 2-2s-.9-2-2-2" />,
	),
	Pin: make("0 0 24 24", 24, <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={PIN_STROKE_PATH} />),
	PinSolid: make(
		"0 0 32 32",
		32,
		<path
			fill="currentColor"
			d="M15.744 4.276c1.221-2.442 4.476-2.97 6.406-1.04l6.614 6.614c1.93 1.93 1.402 5.186-1.04 6.406l-6.35 3.176a1.5 1.5 0 0 0-.753.867l-1.66 4.983a2 2 0 0 1-3.312.782l-4.149-4.15l-6.086 6.087H4v-1.415l6.086-6.085l-4.149-4.15a2 2 0 0 1 .782-3.31l4.982-1.662a1.5 1.5 0 0 0 .868-.752z"
		/>,
	),
	Unpin: make(
		"0 0 24 24",
		24,
		<path
			fill="currentColor"
			d="m20.97 17.172l-1.414 1.414l-3.535-3.535l-.073.074l-.707 3.536l-1.415 1.414l-4.242-4.243l-4.95 4.95l-1.414-1.414l4.95-4.95l-4.243-4.243L5.34 8.761l3.536-.707l.073-.074l-3.536-3.536L6.828 3.03zM10.365 9.394l-.502.502l-2.822.565l6.5 6.5l.564-2.822l.502-.502zm8.411.074l-1.34 1.34l1.414 1.415l1.34-1.34l.707.707l1.415-1.415l-8.486-8.485l-1.414 1.414l.707.707l-1.34 1.34l1.414 1.415l1.34-1.34z"
		/>,
	),
	Mute: make(
		"0 0 24 24",
		20,
		<path
			fill="currentColor"
			d="M12 4L9.91 6.09L12 8.18M4.27 3L3 4.27L7.73 9H3v6h4l5 5v-6.73l4.25 4.26c-.67.51-1.42.93-2.25 1.17v2.07c1.38-.32 2.63-.95 3.68-1.81L19.73 21L21 19.73l-9-9M19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.9 8.9 0 0 0 21 12c0-4.28-3-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71m-2.5 0c0-1.77-1-3.29-2.5-4.03v2.21l2.45 2.45c.05-.2.05-.42.05-.63"
		/>,
	),
	Unmute: make(
		"0 0 24 24",
		20,
		<path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77" />,
	),
	Delete: make("0 0 24 24", 24, <path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM8 9h8v10H8zm7.5-5l-1-1h-5l-1 1H5v2h14V4z" />),
	Archive: make(
		"0 0 24 24",
		24,
		<path
			fill="currentColor"
			d="M20.54 5.23L19.13 3.81A2 2 0 0 0 17.72 3H6.28A2 2 0 0 0 4.87 3.81L3.46 5.23A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5a2 2 0 0 0-.46-1.27zM12 17l-5-5h3V9h4v3h3z"
		/>,
	),
	ArchiveOutline: make(
		"0 0 24 24",
		24,
		<g fill="none" stroke="currentColor" strokeWidth="1.5">
			<path d="M9 12c0-.466 0-.699.076-.883a1 1 0 0 1 .541-.54c.184-.077.417-.077.883-.077h3c.466 0 .699 0 .883.076a1 1 0 0 1 .54.541c.077.184.077.417.077.883s0 .699-.076.883a1 1 0 0 1-.541.54c-.184.077-.417.077-.883.077h-3c-.466 0-.699 0-.883-.076a1 1 0 0 1-.54-.541C9 12.699 9 12.466 9 12Z" />
			<path strokeLinecap="round" d="M20.5 7v6c0 3.771 0 5.657-1.172 6.828S16.271 21 12.5 21h-1c-3.771 0-5.657 0-6.828-1.172S3.5 16.771 3.5 13V7" />
			<path d="M2 5c0-.943 0-1.414.293-1.707S3.057 3 4 3h16c.943 0 1.414 0 1.707.293S22 4.057 22 5s0 1.414-.293 1.707S20.943 7 20 7H4c-.943 0-1.414 0-1.707-.293S2 5.943 2 5Z" />
		</g>,
	),
	Saved: make("0 0 24 24", 26, <path fill="currentColor" d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3l7 3V5c0-1.1-.9-2-2-2z" />),
	Reply: make(
		"0 0 32 32",
		32,
		<path
			fill="currentColor"
			d="M28.88 30a1 1 0 0 1-.88-.5A15.19 15.19 0 0 0 15 22v6a1 1 0 0 1-.62.92a1 1 0 0 1-1.09-.21l-12-12a1 1 0 0 1 0-1.42l12-12a1 1 0 0 1 1.09-.21A1 1 0 0 1 15 4v6.11a17.19 17.19 0 0 1 15 17a16 16 0 0 1-.13 2a1 1 0 0 1-.79.86ZM14.5 20A17.62 17.62 0 0 1 28 26a15.31 15.31 0 0 0-14.09-14a1 1 0 0 1-.91-1V6.41L3.41 16L13 25.59V21a1 1 0 0 1 1-1h.54Z"
		/>,
	),
	ReplyArrow: make("0 0 24 24", 24, <path fill="currentColor" d="M10 9V5l-7 7l7 7v-4.1c5 0 8.5 1.6 11 5.1c-1-5-4-10-11-10" />),
	Forward: make(
		"0 0 24 24",
		24,
		<path fill="currentColor" d="M13 5.499a.996.996 0 0 0-1 1v2.559c-4.5.498-8 4.309-8 8.941v1c2.245-3.423 5.25-3.92 8-3.989v2.489a.999.999 0 0 0 1.707.707L20 11.999l-6.293-6.208A1 1 0 0 0 13 5.499" />,
	),
	Copy: make(
		"0 0 24 24",
		24,
		<g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
			<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
			<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
		</g>,
	),
	Select: make(
		"0 0 24 24",
		24,
		<g fill="none" stroke="currentColor" strokeWidth="2">
			<circle cx="12" cy="12" r="9" />
			<path d="m8 12l3 3l5-6" />
		</g>,
	),
	Emoji: make(
		"0 0 24 24",
		24,
		<path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.828 14.828a4 4 0 0 1-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0" />,
	),
	Send: make(
		"0 0 24 24",
		24,
		<path
			fill="currentColor"
			fillRule="evenodd"
			d="M3.291 3.309a.75.75 0 0 0-.976.996l3.093 6.945H13a.75.75 0 0 1 0 1.5H5.408l-3.093 6.945a.75.75 0 0 0 .976.996l19-8a.75.75 0 0 0 0-1.382z"
			clipRule="evenodd"
		/>,
	),
	ChevronDown: make("0 0 24 24", 24, <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="m7 10l5 5m0 0l5-5" />),
	Seen: make(
		"0 0 24 24",
		24,
		<>
			<circle cx="12" cy="12" r="8" fill="currentColor" opacity="0.3" />
			<path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10s10-4.47 10-10S17.53 2 12 2m0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8s8 3.58 8 8s-3.58 8-8 8" />
		</>,
	),
	Sent: make(
		"0 0 24 24",
		24,
		<path
			fill="currentColor"
			d="M12 22q-2.075 0-3.9-.788t-3.175-2.137T2.788 15.9T2 12t.788-3.9t2.137-3.175T8.1 2.788T12 2t3.9.788t3.175 2.137T21.213 8.1T22 12t-.788 3.9t-2.137 3.175t-3.175 2.138T12 22m0-2q3.35 0 5.675-2.325T20 12t-2.325-5.675T12 4T6.325 6.325T4 12t2.325 5.675T12 20m0-8"
		/>,
	),
	OneTime: make("0 0 24 24", 24, ONE_TIME),
	CapsuleLock: make("0 0 24 24", 24, CAPSULE_LOCK),
	CapsuleUnlock: make("0 0 24 24", 24, CAPSULE_UNLOCK),
	Spinner: make(
		"0 0 24 24",
		14,
		<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="52 10" strokeLinecap="round" />,
	),
	Failed: make(
		"0 0 24 24",
		14,
		<>
			<circle cx="12" cy="12" r="10" fill="none" stroke="var(--danger-color)" strokeWidth="2" />
			<line x1="12" y1="7" x2="12" y2="13" stroke="var(--danger-color)" strokeWidth="2" strokeLinecap="round" />
			<circle cx="12" cy="17" r="1" fill="var(--danger-color)" />
		</>,
	),
	ChatBubble: make(
		"0 0 24 24",
		64,
		<path
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="1.5"
			d="M3.464 16.828C2 15.657 2 14.771 2 11s0-5.657 1.464-6.828C4.93 3 7.286 3 12 3s7.071 0 8.535 1.172S22 7.229 22 11s0 4.657-1.465 5.828C19.072 18 16.714 18 12 18c-2.51 0-3.8 1.738-6 3v-3.212c-1.094-.163-1.899-.45-2.536-.96"
		/>,
	),
	Theme: make("0 0 20 20", 20, <path fill="currentColor" d="M10 3.5a6.5 6.5 0 1 1 0 13zM10 2a8 8 0 1 0 0 16a8 8 0 0 0 0-16" />),
	Palette: make(
		"0 0 24 24",
		20,
		<path
			fill="currentColor"
			d="M12 22C6.49 22 2 17.51 2 12S6.49 2 12 2s10 4.04 10 9c0 3.31-2.69 6-6 6h-1.77c-.28 0-.5.22-.5.5c0 .12.05.23.13.33c.41.47.64 1.06.64 1.67A2.5 2.5 0 0 1 12 22m0-18c-4.41 0-8 3.59-8 8s3.59 8 8 8c.28 0 .5-.22.5-.5a.54.54 0 0 0-.14-.35c-.41-.46-.63-1.05-.63-1.65A2.5 2.5 0 0 1 14.5 15H16c2.21 0 4-1.79 4-4c0-3.86-3.59-7-8-7"
		/>,
	),
	Eyedropper: make(
		"0 0 24 24",
		14,
		<path fill="currentColor" d="M20.71 5.63l-2.34-2.34a1 1 0 0 0-1.41 0l-3.12 3.12l-1.41-1.42l-1.42 1.42l1.41 1.41l-6.6 6.6A2 2 0 0 0 5 16v3h3a2 2 0 0 0 1.42-.59l6.6-6.6l1.41 1.42l1.42-1.42l-1.42-1.41l3.12-3.12a1 1 0 0 0 0-1.65M8 17H7v-1l6.6-6.6l1 1z" />,
	),
	Image: make(
		"0 0 24 24",
		20,
		<path fill="currentColor" d="M21 3H3C2 3 1 4 1 5v14c0 1.1.9 2 2 2h18c1 0 2-1 2-2V5c0-1-1-2-2-2m0 16H3V5h18zm-9-9l-3 4h8l-2.5-3.5zM5 16l3-4l2 2.7L13 10l5 6z" />,
	),
	Online: make(
		"0 0 24 24",
		24,
		<path
			fill="currentColor"
			d="M12 22q-2.075 0-3.9-.788t-3.175-2.137T2.788 15.9T2 12t.788-3.9t2.137-3.175T8.1 2.788T12 2t3.9.788t3.175 2.137T21.213 8.1T22 12t-.788 3.9t-2.137 3.175t-3.175 2.138T12 22m0-2q3.35 0 5.675-2.325T20 12t-2.325-5.675T12 4T6.325 6.325T4 12t2.325 5.675T12 20m0-8"
		/>,
	),
	Email: make(
		"0 0 24 24",
		24,
		<g fill="none">
			<path fill="currentColor" d="M3 5V4a1 1 0 0 0-1 1zm18 0h1a1 1 0 0 0-1-1zM3 6h18V4H3zm17-1v12h2V5zm-1 13H5v2h14zM4 17V5H2v12zm1 1a1 1 0 0 1-1-1H2a3 3 0 0 0 3 3zm15-1a1 1 0 0 1-1 1v2a3 3 0 0 0 3-3z" />
			<path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m3 5l9 9l9-9" />
		</g>,
	),
	Person: make("0 0 24 24", 20, <path fill="currentColor" d="M12 12a5 5 0 1 0 0-10a5 5 0 0 0 0 10zm0 2c-5.33 0-8 2.67-8 5v1h16v-1c0-2.33-2.67-5-8-5z" />),
	Lock: make(
		"0 0 24 24",
		24,
		<path fill="currentColor" d="M17 9V7A5 5 0 0 0 7 7v2a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-7a3 3 0 0 0-3-3M9 7a3 3 0 0 1 6 0v2H9Zm9 12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1Z" />,
	),
	EyeOpen: make(
		"0 0 24 24",
		20,
		<g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
			<circle cx="12" cy="12" r="3" />
		</g>,
	),
	EyeClosed: make(
		"0 0 24 24",
		20,
		<g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
			<path d="M1 1l22 22" />
		</g>,
	),
	Rotate: make(
		"0 0 24 24",
		24,
		<path
			fill="currentColor"
			d="M12 6v3l4-4l-4-4v3a8 8 0 0 0-8 8c0 1.57.46 3.03 1.24 4.26L6.7 14.8A5.9 5.9 0 0 1 6 12a6 6 0 0 1 6-6m6.76 1.74L17.3 9.2c.44.84.7 1.8.7 2.8a6 6 0 0 1-6 6v-3l-4 4l4 4v-3a8 8 0 0 0 8-8c0-1.57-.46-3.03-1.24-4.26"
		/>,
	),
	Bell: make(
		"0 0 24 24",
		20,
		<path
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="2"
			d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9m4.3 13a1.94 1.94 0 0 0 3.4 0"
		/>,
	),
	Devices: make(
		"0 0 24 24",
		20,
		<g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
			<rect width="13" height="10" x="2" y="4" rx="2" />
			<path d="M6 18h5M8.5 14v4" />
			<rect width="6" height="11" x="16" y="9" rx="1.5" />
		</g>,
	),
	Block: make(
		"0 0 24 24",
		20,
		<g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2">
			<circle cx="12" cy="12" r="9" />
			<path d="M5.7 5.7l12.6 12.6" />
		</g>,
	),
	Unarchive: make(
		"0 0 24 24",
		20,
		<path fill="currentColor" d="M20.54 5.23L19.13 3.81A2 2 0 0 0 17.72 3H6.28A2 2 0 0 0 4.87 3.81L3.46 5.23A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5a2 2 0 0 0-.46-1.27zM12 7l5 5h-3v3H10v-3H7z" />,
	),
	Phone: make(
		"0 0 24 24",
		22,
		<g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
			<rect width="12" height="20" x="6" y="2" rx="2.5" />
			<path d="M11 18h2" />
		</g>,
	),
	Desktop: make(
		"0 0 24 24",
		22,
		<g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
			<rect width="20" height="13" x="2" y="3" rx="2" />
			<path d="M8 21h8M12 16v5" />
		</g>,
	),
};

export type IconName = keyof typeof Icons;
