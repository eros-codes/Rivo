// Reading pictures chosen on this device (never uploaded as they are).

export interface Decoded {
	source: CanvasImageSource;
	width: number;
	height: number;
	close: () => void;
}

/** Decodes an image file, turned the way the camera held it. */
export async function decodeImage(file: Blob): Promise<Decoded> {
	if (typeof createImageBitmap === "function") {
		try {
			const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
			return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
		} catch {
			// some formats only decode through <img>
		}
	}
	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		img.decoding = "async";
		img.src = url;
		await img.decode();
		return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
	} finally {
		URL.revokeObjectURL(url);
	}
}

/**
 * The picture as a JPEG data URL no larger than `maxChars`, shrunk until it
 * fits (a wallpaper lives in localStorage, which holds only a few MB).
 */
export async function toJpegDataUrl(file: Blob, opts: { maxSide: number; maxChars: number; background?: string }): Promise<string> {
	const img = await decodeImage(file);
	try {
		if (!img.width || !img.height) throw new Error("empty image");
		let side = opts.maxSide;
		for (let attempt = 0; attempt < 4; attempt++) {
			const scale = Math.min(1, side / Math.max(img.width, img.height));
			const w = Math.max(1, Math.round(img.width * scale));
			const h = Math.max(1, Math.round(img.height * scale));
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("no canvas");
			// JPEG has no transparency
			ctx.fillStyle = opts.background ?? "#fff";
			ctx.fillRect(0, 0, w, h);
			ctx.imageSmoothingQuality = "high";
			ctx.drawImage(img.source, 0, 0, w, h);
			const url = canvas.toDataURL("image/jpeg", attempt === 0 ? 0.82 : 0.75);
			if (url.length <= opts.maxChars) return url;
			side = Math.round(side * 0.75);
		}
		throw new Error("image too large");
	} finally {
		img.close();
	}
}
