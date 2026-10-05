// Choosing the part of a picture that becomes the profile picture: the
// picture moves under a round frame (drag, pinch, wheel or the slider) and
// the framed square is saved as a 400×400 JPEG.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Dialog } from "../../../shared/ui/Dialog";

const OUTPUT = 400;
const FRAME = 0.8; // of the smaller side of the view
const MAX_ZOOM = 4;

interface View {
	/** image scale (screen px per image px) */
	scale: number;
	/** image top-left in the view */
	x: number;
	y: number;
}

export function AvatarCropper({ file, busy, onCancel, onDone }: { file: File; busy: boolean; onCancel: () => void; onDone: (jpeg: Blob) => void }) {
	const box = useRef<HTMLDivElement>(null);
	const [img, setImg] = useState<HTMLImageElement | null>(null);
	const [url, setUrl] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [size, setSize] = useState({ w: 0, h: 0 });
	const [view, setView] = useState<View | null>(null);
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const pinch = useRef<{ dist: number; scale: number } | null>(null);

	// the picture, read locally (never uploaded uncropped)
	useEffect(() => {
		const u = URL.createObjectURL(file);
		setUrl(u);
		const image = new Image();
		image.onload = () => setImg(image);
		image.onerror = () => setFailed(true);
		image.src = u;
		return () => URL.revokeObjectURL(u);
	}, [file]);

	useEffect(() => {
		const el = box.current;
		if (!el) return undefined;
		const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const frame = Math.min(size.w, size.h) * FRAME;
	const frameX = (size.w - frame) / 2;
	const frameY = (size.h - frame) / 2;
	const minScale = img ? Math.max(frame / img.naturalWidth, frame / img.naturalHeight) : 1;

	/** Keeps the frame covered by the picture. */
	const clamp = useCallback(
		(v: View): View => {
			if (!img) return v;
			const scale = Math.min(Math.max(v.scale, minScale), minScale * MAX_ZOOM);
			const w = img.naturalWidth * scale;
			const h = img.naturalHeight * scale;
			const x = Math.min(frameX, Math.max(frameX + frame - w, v.x));
			const y = Math.min(frameY, Math.max(frameY + frame - h, v.y));
			return { scale, x, y };
		},
		[img, minScale, frame, frameX, frameY],
	);

	// start centered, the frame filled
	useEffect(() => {
		if (!img || !frame) return;
		const scale = minScale;
		setView(clamp({ scale, x: (size.w - img.naturalWidth * scale) / 2, y: (size.h - img.naturalHeight * scale) / 2 }));
	}, [img, frame, minScale, size.w, size.h, clamp]);

	/** Zoom to `scale` keeping the point (px, py) of the view where it is. */
	const zoomAt = (scale: number, px: number, py: number) => {
		setView((v) => {
			if (!v) return v;
			const k = Math.min(Math.max(scale, minScale), minScale * MAX_ZOOM) / v.scale;
			return clamp({ scale: v.scale * k, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
		});
	};

	const local = (e: { clientX: number; clientY: number }) => {
		const r = box.current!.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	};

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		pointers.current.set(e.pointerId, local(e));
		if (pointers.current.size === 2 && view) {
			const [a, b] = [...pointers.current.values()];
			pinch.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), scale: view.scale };
		}
	};
	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const prev = pointers.current.get(e.pointerId);
		if (!prev || !view) return;
		const now = local(e);
		pointers.current.set(e.pointerId, now);
		if (pointers.current.size === 2 && pinch.current) {
			const [a, b] = [...pointers.current.values()];
			const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
			zoomAt((pinch.current.scale * dist) / pinch.current.dist, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
			return;
		}
		setView((v) => (v ? clamp({ ...v, x: v.x + now.x - prev.x, y: v.y + now.y - prev.y }) : v));
	};
	const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		pointers.current.delete(e.pointerId);
		if (pointers.current.size < 2) pinch.current = null;
	};

	// the wheel zooms (a native listener: React's wheel listener is passive)
	useEffect(() => {
		const el = box.current;
		if (!el) return undefined;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const r = el.getBoundingClientRect();
			setView((v) => {
				if (!v) return v;
				const target = v.scale * Math.exp(-e.deltaY * 0.0015);
				const k = Math.min(Math.max(target, minScale), minScale * MAX_ZOOM) / v.scale;
				const px = e.clientX - r.left;
				const py = e.clientY - r.top;
				return clamp({ scale: v.scale * k, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
			});
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [minScale, clamp]);

	const apply = () => {
		if (!img || !view) return;
		const canvas = document.createElement("canvas");
		canvas.width = OUTPUT;
		canvas.height = OUTPUT;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		// JPEG has no transparency: empty corners become white, not black
		ctx.fillStyle = "#fff";
		ctx.fillRect(0, 0, OUTPUT, OUTPUT);
		ctx.imageSmoothingQuality = "high";
		const sx = (frameX - view.x) / view.scale;
		const sy = (frameY - view.y) / view.scale;
		const s = frame / view.scale;
		ctx.drawImage(img, sx, sy, s, s, 0, 0, OUTPUT, OUTPUT);
		canvas.toBlob((blob) => blob && onDone(blob), "image/jpeg", 0.9);
	};

	const zoomPercent = view && minScale ? (view.scale / minScale - 1) / (MAX_ZOOM - 1) : 0;

	return (
		<Dialog className="avatar-crop-dialog" onClose={() => !busy && onCancel()} label="Crop picture" closeOnBackdrop={false}>
			<div
				ref={box}
				className="avatar-crop-container"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
			>
				{failed && <p className="avatar-crop-error">This image can&apos;t be opened. Please try another one.</p>}
				{url && img && view && (
					<img
						src={url}
						alt=""
						draggable={false}
						className="avatar-crop-image"
						style={{ width: img.naturalWidth * view.scale, height: img.naturalHeight * view.scale, transform: `translate(${view.x}px, ${view.y}px)` }}
					/>
				)}
				{frame > 0 && <div className="avatar-crop-frame" style={{ left: frameX, top: frameY, width: frame, height: frame }} />}
			</div>
			<input
				type="range"
				className="avatar-crop-zoom"
				aria-label="Zoom"
				min={0}
				max={1}
				step={0.01}
				value={zoomPercent}
				onChange={(e) => zoomAt(minScale * (1 + Number(e.target.value) * (MAX_ZOOM - 1)), size.w / 2, size.h / 2)}
			/>
			<div className="avatar-crop-actions">
				<button type="button" className="avatar-crop-cancel" disabled={busy} onClick={onCancel}>
					Cancel
				</button>
				<button type="button" className="avatar-crop-confirm" disabled={busy || !view} onClick={apply}>
					{busy ? "Saving…" : "Apply"}
				</button>
			</div>
		</Dialog>
	);
}
