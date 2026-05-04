import { buildHeaders, safeFetch } from "./api.js";

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

    _dom.addContactUsername.addEventListener("keydown", (e) => {
        if (e.key === "Enter") _handleSubmit();
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

        try {
        try {
            const data = await safeFetch("/api/contacts", {
                method: "POST",
                credentials: "include",
                headers: buildHeaders(),
                body: JSON.stringify({ username, name }),
            });
            closeAddContact();
            _onContactAdded?.(data);
        } catch (err) {
            const body = err.body || {};
            _dom.addContactError.textContent = body.error || err.message || "Something went wrong";
            _dom.addContactSubmit.disabled = false;
            return;
        }
    } catch {
        _dom.addContactError.textContent = "Connection error";
        _dom.addContactSubmit.disabled = false;
    }
}