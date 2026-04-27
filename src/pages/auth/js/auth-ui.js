export function showForm(allForms, targetForm) {
	allForms.forEach((f) => (f.style.display = "none"));
	if (targetForm) targetForm.style.display = "flex";
}

export function showError(input, message) {
	clearError(input);
	input.style.borderColor = "#e05c5c";
	const err = document.createElement("span");
	err.className = "input-error";
	err.textContent = message;
	err.style.cssText =
		"color:#e05c5c;font-size:0.75rem;margin-top:-0.5rem;display:block;";
	input.insertAdjacentElement("afterend", err);
}

export function clearError(input) {
	input.style.borderColor = "";
	const next = input.nextElementSibling;
	if (next && next.classList.contains("input-error")) next.remove();
}
