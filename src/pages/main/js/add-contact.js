import { buildHeaders, safeFetch } from "../../../utils/fetch.js";

let _dom = {};
let _onContactAdded = null;

export function initAddContact(dom, onContactAdded) {
    _dom = dom;
    _onContactAdded = onContactAdded;

    _dom.addFriendsBtn.addEventListener("click", openAddContact);
    _dom.addContactCancel.addEventListener("click", closeAddContact);
    _dom.addContactSubmit.addEventListener("click", _handleSubmit);

    _dom.addContactDialog.addEventListener("click", (e) => {
        if (e.target === _dom.addContactDialog) closeAddContact();
    });

    _dom.addContactName.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            _dom.addContactUsername.focus();
        }
    });
    _dom.addContactUsername.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            _handleSubmit();
        }
    });
}

export function openAddContact() {
    _dom.addContactName.value = "";
    _dom.addContactUsername.value = "";
    _dom.addContactError.textContent = "";
    _dom.addContactSubmit.disabled = false;
    _dom.addContactDialog.showModal();
    _dom.addContactName.focus();
}

export function closeAddContact() {
    _dom.addContactDialog.close();
}

async function _handleSubmit() {
    // Enter while a request is already on its way must not add twice
    if (_dom.addContactSubmit.disabled) return;
    const name = _dom.addContactName.value.trim();
    const username = _dom.addContactUsername.value.trim().replace(/^@/, "");

    if (!name) {
        _dom.addContactError.textContent = "Name is required";
        _dom.addContactName.focus();
        return;
    }

    if (!username) {
        _dom.addContactError.textContent = "Username is required";
        _dom.addContactUsername.focus();
        return;
    }

    _dom.addContactSubmit.disabled = true;
    _dom.addContactError.textContent = "";

    let data;
    try {
        data = await safeFetch("/api/contacts", {
            method: "POST",
            credentials: "include",
            headers: buildHeaders(),
            body: JSON.stringify({ username, name }),
        });
    } catch (err) {
        // safeFetch puts the server's message (e.g. "User not found") in err.message
        _dom.addContactError.textContent =
            err && err.status ? err.message || "Something went wrong" : "Connection error";
        _dom.addContactSubmit.disabled = false;
        return;
    }
    closeAddContact();
    try {
        await _onContactAdded?.(data);
    } catch (e) {
        console.error("add contact: opening the chat failed", e);
    }
}