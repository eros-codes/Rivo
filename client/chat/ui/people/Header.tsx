// The top bar: settings menu, search and "add contact".
import { useEffect, useRef, useState } from "react";
import { Icons } from "../../../shared/ui/icons";
import { pressable } from "../../../shared/ui/pressable";
import { useOutsidePointer } from "../../../shared/lib/hooks";
import { showToast } from "../../services/feedback";
import { closeSearch, openDialog, openPanel, openSearch, setSearchQuery } from "../../services/navigation";
import { logout } from "../../services/session";
import { searchResultsRef } from "../refs";
import { useUi } from "../selectors";

function SettingsMenu() {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLUListElement>(null);
	useOutsidePointer([ref], () => setOpen(false), open);

	const onSettings = () => {
		// the first tap opens the menu (on touch screens there is no hover);
		// a mouse already opened it by hovering, a keyboard by focusing
		const list = ref.current;
		const expanded = open || (!!list && ((window.matchMedia("(hover: hover)").matches && list.matches(":hover")) || !!list.querySelector(":focus-visible")));
		if (!expanded) {
			setOpen(true);
			return;
		}
		setOpen(false);
		ref.current?.querySelector<HTMLElement>(":focus")?.blur();
		openPanel("settings");
	};
	const onEdit = () => {
		setOpen(false);
		ref.current?.querySelector<HTMLElement>(":focus")?.blur();
		openPanel("editProfile");
	};
	const onLogout = async () => {
		try {
			await logout();
		} catch {
			showToast("Couldn't log out. Check your connection and try again.", { icon: "error" });
		}
	};

	return (
		<>
			<span className="settings" aria-hidden="true">
				<Icons.Gear />
			</span>
			<ul ref={ref} className={`settings-list${open ? " open" : ""}`} aria-label="Menu">
				<li className="settings-section" {...pressable(onSettings)} aria-label="Settings">
					<Icons.Gear className="settings-icon" />
					<span>Settings</span>
				</li>
				<li className="edit-section" {...pressable(onEdit)}>
					<Icons.Edit />
					<span>Edit Profile</span>
				</li>
				<li className="logout-section" {...pressable(() => void onLogout())}>
					<Icons.Logout />
					<span>Log Out</span>
				</li>
			</ul>
		</>
	);
}

function SearchBox() {
	const search = useUi((s) => s.search);
	const [text, setText] = useState(search.query);
	const bar = useRef<HTMLSpanElement>(null);
	const input = useRef<HTMLInputElement>(null);

	// closed from elsewhere (opening a chat, back button): the box empties
	useEffect(() => {
		if (!search.open && !search.query) setText("");
	}, [search.open, search.query]);

	// typing waits a moment before searching
	useEffect(() => {
		const q = text.trim();
		if (q === search.query) return undefined;
		const t = window.setTimeout(() => setSearchQuery(q), 250);
		return () => window.clearTimeout(t);
	}, [text, search.query]);

	useOutsidePointer([bar, searchResultsRef], () => closeSearch(), search.open);

	return (
		<span
			ref={bar}
			className={`search-bar${search.open ? " open" : ""}`}
			onClick={(e) => {
				if (e.target === input.current) {
					openSearch();
					return;
				}
				if (search.open) closeSearch();
				else {
					openSearch();
					input.current?.focus();
				}
			}}
		>
			<Icons.Search />
			<input
				ref={input}
				type="text"
				enterKeyHint="search"
				placeholder="Search..."
				className="search-input"
				name="search"
				aria-label="Search contacts and messages"
				autoComplete="off"
				value={text}
				maxLength={100}
				onFocus={openSearch}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						closeSearch();
						input.current?.blur();
					}
				}}
			/>
		</span>
	);
}

export function Header({ hidden }: { hidden: boolean }) {
	return (
		<header className="main-header" style={hidden ? { display: "none" } : undefined}>
			<SettingsMenu />
			<SearchBox />
			<span className="add-friends" {...pressable(() => openDialog("addContact"))} aria-label="Add contact">
				<Icons.AddFriend />
			</span>
		</header>
	);
}
