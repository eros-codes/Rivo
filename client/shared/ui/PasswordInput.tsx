// A password field with a show/hide button.
import { useState, type Ref } from "react";
import { Icons } from "./icons";

export function PasswordInput({
	value,
	onChange,
	placeholder,
	autoComplete,
	id,
	name,
	className,
	inputRef,
	autoFocus,
	label,
	invalid,
	describedBy,
	required,
	wrapperClass = "password-wrapper",
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	autoComplete: "current-password" | "new-password";
	id?: string;
	name?: string;
	className?: string;
	inputRef?: Ref<HTMLInputElement>;
	autoFocus?: boolean;
	/** the accessible name when there is no <label> */
	label?: string;
	invalid?: boolean;
	/** the id of the text that explains a problem with it */
	describedBy?: string;
	required?: boolean;
	wrapperClass?: string;
}) {
	const [shown, setShown] = useState(false);
	return (
		<div className={wrapperClass}>
			<input
				ref={inputRef}
				id={id}
				name={name}
				type={shown ? "text" : "password"}
				className={className}
				value={value}
				placeholder={placeholder}
				autoComplete={autoComplete}
				autoCapitalize="none"
				autoCorrect="off"
				spellCheck={false}
				autoFocus={autoFocus}
				aria-label={label}
				aria-invalid={invalid || undefined}
				aria-describedby={describedBy}
				required={required}
				onChange={(e) => onChange(e.target.value)}
			/>
			<button type="button" className="password-toggle" aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown} onClick={() => setShown((v) => !v)}>
				{shown ? <Icons.EyeOpen /> : <Icons.EyeClosed />}
			</button>
		</div>
	);
}
