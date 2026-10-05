// Choosing when a time capsule opens: between 5 minutes and a year from now.
import { useId, useState } from "react";
import { fromLocalInputValue, toLocalInputValue } from "../../../shared/lib/time";
import { Dialog } from "../../../shared/ui/Dialog";
import { showToast } from "../../services/feedback";
import { CAPSULE_MAX_DELAY_MS as MAX_MS, CAPSULE_MIN_DELAY_MS as MIN_MS } from "../../../../shared/limits.ts";


const toMinute = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), 0, 0);

export function CapsulePicker({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (iso: string) => void }) {
	const now = toMinute(new Date());
	const min = new Date(now.getTime() + MIN_MS);
	const max = new Date(now.getTime() + MAX_MS);
	const [value, setValue] = useState(() => toLocalInputValue(min));
	const titleId = useId();

	const confirm = () => {
		const chosen = fromLocalInputValue(value);
		const base = toMinute(new Date());
		if (!chosen || chosen.getTime() < base.getTime() + MIN_MS || chosen.getTime() > base.getTime() + MAX_MS) {
			showToast("Selected time out of range (min +5 minutes, max +1 year)", { icon: "error" });
			return;
		}
		onConfirm(toMinute(chosen).toISOString());
	};

	return (
		<Dialog className="capsule-picker-wrap" onClose={onCancel} labelledBy={titleId}>
			<div className="capsule-picker-dialog">
				<div className="capsule-picker-title" id={titleId}>
					⏳ Set unlock time
				</div>
				<input
					className="capsule-datetime-input"
					type="datetime-local"
					min={toLocalInputValue(min)}
					max={toLocalInputValue(max)}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							confirm();
						}
					}}
				/>
				<div className="capsule-picker-actions">
					<button type="button" onClick={onCancel}>
						Cancel
					</button>
					<button type="button" className="capsule-confirm" onClick={confirm}>
						Set &amp; Arm 💣
					</button>
				</div>
			</div>
		</Dialog>
	);
}
