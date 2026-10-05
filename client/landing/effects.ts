// The landing page's motion, without an animation library: the drawn cursor,
// the tilting chat bubbles, the scroll reveals and the background parallax.
// Everything respects "reduce motion" and stops working when idle.
import { useEffect, useState, type RefObject } from "react";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = () => window.matchMedia("(pointer: fine)").matches;

/** Runs `step` every frame until it returns false; `kick()` starts it again. */
function frameLoop(step: () => boolean): { kick: () => void; stop: () => void } {
	let id = 0;
	const tick = () => {
		id = step() ? requestAnimationFrame(tick) : 0;
	};
	return {
		kick: () => {
			if (!id) id = requestAnimationFrame(tick);
		},
		stop: () => {
			cancelAnimationFrame(id);
			id = 0;
		},
	};
}

/** A dot and a trailing ring that follow the mouse (mouse only). */
export function useCustomCursor(dot: RefObject<HTMLDivElement | null>, ring: RefObject<HTMLDivElement | null>): void {
	useEffect(() => {
		if (!finePointer() || reducedMotion() || !dot.current || !ring.current) return undefined;
		const d = dot.current;
		const r = ring.current;
		const root = document.documentElement;
		let mx = 0;
		let my = 0;
		let cx = 0;
		let cy = 0;
		let rx = 0;
		let ry = 0;
		let shown = false;
		const loop = frameLoop(() => {
			cx += (mx - cx) * 0.22;
			cy += (my - cy) * 0.22;
			rx += (mx - rx) * 0.12;
			ry += (my - ry) * 0.12;
			d.style.transform = `translate3d(${cx}px, ${cy}px, 0) translate(-50%, -50%)`;
			r.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%)`;
			return Math.abs(mx - rx) > 0.3 || Math.abs(my - ry) > 0.3;
		});
		const onMove = (e: MouseEvent) => {
			mx = e.clientX;
			my = e.clientY;
			if (!shown) {
				shown = true;
				cx = rx = mx;
				cy = ry = my;
				root.classList.add("custom-cursor");
				d.classList.add("visible");
				r.classList.add("visible");
			}
			loop.kick();
		};
		// leaving the window: the system cursor takes over outside it
		const onLeave = () => {
			d.classList.remove("visible");
			r.classList.remove("visible");
			shown = false;
		};
		document.addEventListener("mousemove", onMove, { passive: true });
		document.documentElement.addEventListener("mouseleave", onLeave);
		return () => {
			loop.stop();
			document.removeEventListener("mousemove", onMove);
			document.documentElement.removeEventListener("mouseleave", onLeave);
			root.classList.remove("custom-cursor");
		};
	}, [dot, ring]);
}

/** The hero's chat bubbles lean toward the mouse. */
export function useTilt(scene: RefObject<HTMLElement | null>, cluster: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		if (!finePointer() || reducedMotion() || !scene.current || !cluster.current) return undefined;
		const el = cluster.current;
		const MAX = 15;
		let tx = 0;
		let ty = 0;
		let x = 0;
		let y = 0;
		const clamp = (v: number) => Math.max(-MAX, Math.min(MAX, v));
		const loop = frameLoop(() => {
			x += (tx - x) * 0.06;
			y += (ty - y) * 0.06;
			el.style.transform = `rotateX(${clamp(x)}deg) rotateY(${clamp(y)}deg)`;
			return Math.abs(tx - x) > 0.02 || Math.abs(ty - y) > 0.02;
		});
		const onMove = (e: MouseEvent) => {
			const rect = scene.current?.getBoundingClientRect();
			if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) return;
			const dx = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2 || window.innerWidth / 2);
			const dy = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2 || window.innerHeight / 2);
			ty = clamp(dx * MAX);
			tx = clamp(-dy * MAX);
			loop.kick();
		};
		document.addEventListener("mousemove", onMove, { passive: true });
		return () => {
			loop.stop();
			document.removeEventListener("mousemove", onMove);
		};
	}, [scene, cluster]);
}

/** Whether the page has scrolled past `y` (the bar turns dark). */
export function useScrolledPast(y: number): boolean {
	const [past, setPast] = useState(false);
	useEffect(() => {
		const check = () => setPast(window.scrollY > y);
		check();
		window.addEventListener("scroll", check, { passive: true });
		return () => window.removeEventListener("scroll", check);
	}, [y]);
	return past;
}

/** The hero's glows drift up a little slower than the page scrolls. */
export function useParallax(hero: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		const section = hero.current;
		if (!section || reducedMotion()) return undefined;
		const blobs: [HTMLElement | null, number][] = [
			[section.querySelector<HTMLElement>(".blob-1"), -80],
			[section.querySelector<HTMLElement>(".blob-2"), -50],
		];
		let frame = 0;
		const update = () => {
			frame = 0;
			const progress = Math.min(1, Math.max(0, window.scrollY / Math.max(1, section.offsetHeight)));
			// `translate` adds to the blobs' own drifting animation
			for (const [el, distance] of blobs) if (el) el.style.translate = `0 ${(progress * distance).toFixed(1)}px`;
		};
		const onScroll = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		update();
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("scroll", onScroll);
		};
	}, [hero]);
}

const REVEAL_SELECTOR = ".reveal, .reveal-left, .reveal-right, .reveal-scale";

/**
 * Sections slide in as they are scrolled to. Only what is still below the
 * screen when this starts is hidden first, so nothing on screen flashes.
 */
export function useScrollReveal(root: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		const container = root.current;
		if (!container || reducedMotion() || !("IntersectionObserver" in window)) return undefined;
		const limit = window.innerHeight * 0.95;
		const waiting = [...container.querySelectorAll<HTMLElement>(REVEAL_SELECTOR)].filter((el) => el.getBoundingClientRect().top > limit);
		const timers: number[] = [];
		const io = new IntersectionObserver(
			(entries) => {
				let order = 0;
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const el = entry.target as HTMLElement;
					io.unobserve(el);
					// those arriving together come one after another
					el.style.transitionDelay = `${order++ * 60}ms`;
					el.classList.add("revealing");
					requestAnimationFrame(() => el.classList.remove("will-reveal"));
					timers.push(
						window.setTimeout(() => {
							el.classList.remove("revealing");
							el.style.transitionDelay = "";
						}, 1200 + order * 60),
					);
				}
			},
			{ rootMargin: "0px 0px -15% 0px" },
		);
		for (const el of waiting) {
			el.classList.add("will-reveal");
			io.observe(el);
		}
		return () => {
			io.disconnect();
			timers.forEach((t) => window.clearTimeout(t));
			for (const el of waiting) el.classList.remove("will-reveal", "revealing");
		};
	}, [root]);
}
