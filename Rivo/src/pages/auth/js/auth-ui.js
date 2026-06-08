export function showForm(allForms, targetForm) {
	allForms.forEach((f) => (f.style.display = "none"));
	if (targetForm) targetForm.style.display = "flex";
}

export function showError(input, message) {
	clearError(input);
	const err = document.createElement("span");
	err.className = "input-error";
	err.textContent = message;
	err.style.cssText =
		"color:#e05c5c;font-size:0.75rem;margin-top:-0.5rem;display:block;";

	// Special handling for verification code inputs: place the error under
	// the form subtitle instead of between the digit inputs.
	try {
		const isCodeDigit = input && input.classList && input.classList.contains('code-digit');
		const isHiddenCode = input && input.id === 'code-hidden';
		if ((isCodeDigit || isHiddenCode) && input.closest) {
			const form = input.closest('form');
			const subtitle = form && form.querySelector('.form-subtitle');
			if (subtitle) {
				// mark all code inputs visually as errored
				const codeInputs = form.querySelectorAll && form.querySelectorAll('.code-digit');
				codeInputs && codeInputs.forEach(i => { try { i.style.borderColor = '#e05c5c'; } catch (e) {} });
				subtitle.insertAdjacentElement('afterend', err);
				return;
			}
		}
	} catch (e) {
		// fallthrough to default placement
	}

	// default placement: immediately after the target input
	try { input.style.borderColor = "#e05c5c"; } catch (e) {}
	if (input && typeof input.insertAdjacentElement === 'function') {
		input.insertAdjacentElement("afterend", err);
	} else {
		// fallback: append to form or document body
		const form = input && input.closest ? input.closest('form') : null;
		if (form) form.appendChild(err);
		else document.body.appendChild(err);
	}
}

export function clearError(input) {
	try { input.style.borderColor = ""; } catch (e) {}
	const next = input && input.nextElementSibling;
	if (next && next.classList && next.classList.contains("input-error")) next.remove();

	// Also clear any form-level error that may have been placed under
	// the `.form-subtitle` (used by the verification form).
	try {
		const form = input && input.closest ? input.closest('form') : null;
		if (form) {
			const subErr = form.querySelector('.form-subtitle + .input-error');
			if (subErr) subErr.remove();
			// clear visual error state for code inputs
			const codeInputs = form.querySelectorAll('.code-digit');
			if (codeInputs && codeInputs.length) {
				codeInputs.forEach(i => { try { i.style.borderColor = ''; } catch (e) {} });
			}
		}
	} catch (e) {
		/* ignore */
	}
}
