(function(){
	// Minimal cursor script (external to satisfy CSP 'self')
	const cursor = document.getElementById('cursor');
	const cursorRing = document.getElementById('cursorRing');
	if (!cursor && !cursorRing) return;

	let mx = 0, my = 0, cx = 0, cy = 0, rx = 0, ry = 0;
	let __cursorVisible = false;

	const updatePos = (e) => {
		const p = (e.touches && e.touches[0]) ? e.touches[0] : e;
		mx = p.clientX || 0;
		my = p.clientY || 0;
		if (!__cursorVisible) {
			__cursorVisible = true;
			try { if (cursor) cursor.style.opacity = '1'; } catch (e) {}
			try { if (cursorRing) cursorRing.style.opacity = '1'; } catch (e) {}
		}
	};

	document.addEventListener('mousemove', updatePos, { passive: true });
	document.addEventListener('touchstart', updatePos, { passive: true });
	document.addEventListener('touchmove', updatePos, { passive: true });

	(function render(){
		cx += (mx - cx) * 0.22;
		cy += (my - cy) * 0.22;
		if (cursor) cursor.style.transform = `translate3d(${cx}px, ${cy}px, 0) translate(-50%, -50%)`;

		// slower interpolation for the ring to create a smoother trailing effect
		rx += (mx - rx) * 0.06;
		ry += (my - ry) * 0.06;
		if (cursorRing) cursorRing.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%)`;
		requestAnimationFrame(render);
	})();

		// Hover sizing is handled by CSS (body:has selectors in the landing stylesheet)
})();
