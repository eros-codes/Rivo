window.addEventListener("load", () => {
    const theme = localStorage.getItem("rivo-theme");
    if (theme === "dark") document.body.style.background = "#1a1a1a";

    const accent = localStorage.getItem("rivo-accent");
    if (accent) document.documentElement.style.setProperty("--accent", accent);

    setTimeout(() => {
        (async () => {
            try {
                const res = await fetch('/api/users/me', { credentials: 'include' });
                if (res.ok) {
                    window.location.href = '/chat/main.html';
                } else {
                    window.location.href = '/auth/auth.html';
                }
            } catch (e) {
                window.location.href = '/auth/auth.html';
            }
        })();
    }, 1600);
});
