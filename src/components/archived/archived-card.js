import { safeSrc } from "../../utils/dom.js";
import { parseSvg } from "../../utils/svg.js";

const unarchiveIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M20.54 5.23L19.13 3.81A2 2 0 0 0 17.72 3H6.28A2 2 0 0 0 4.87 3.81L3.46 5.23A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5a2 2 0 0 0-.46-1.27zM12 7l5 5h-3v3H10v-3H7z"/></svg>`;

/**
 * @param {{ id, name, nickname, profilePics, isOnline }} contact
 * @param {(id: number) => void} onUnarchive
 * @param {(id: number) => void} onOpen
 */
export function createArchivedCard(contact, onUnarchive, onOpen) {
    const { id, name, nickname, profilePics, isOnline } = contact;

    const wrapper = document.createElement("div");
    wrapper.className = "archived-card";
    wrapper.dataset.userId = id;

    // Left side — avatar + name
    const left = document.createElement("div");
    left.className = "archived-card-left";

    const img = document.createElement("img");
    img.className = `archived-card-avatar${isOnline ? " online" : ""}`;
    img.src = safeSrc((profilePics && profilePics[0]) || "/assets/images/profile.jpeg");
    img.alt = "";

    const nameEl = document.createElement("span");
    nameEl.className = "archived-card-name";
    nameEl.textContent = nickname || name || "";

    left.appendChild(img);
    left.appendChild(nameEl);

    // Right side — unarchive button
    const unarchiveBtn = document.createElement("button");
    unarchiveBtn.className = "archived-card-unarchive-btn";
    unarchiveBtn.title = "Unarchive";
    unarchiveBtn.setAttribute("aria-label", "Unarchive");
    const _icon = parseSvg(unarchiveIconSvg);
    if (_icon) unarchiveBtn.appendChild(_icon.cloneNode(true));

    wrapper.appendChild(left);
    wrapper.appendChild(unarchiveBtn);

    // Click card → open chat
    wrapper.addEventListener("click", (e) => {
        if (e.target.closest(".archived-card-unarchive-btn")) return;
        onOpen(id);
    });

    // Click unarchive
    unarchiveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onUnarchive(id);
    });

    return wrapper;
}