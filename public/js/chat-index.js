window.addEventListener("load", () => {
    const theme = localStorage.getItem("rivo-theme");
    if (theme === "dark") document.body.style.background = "#1a1a1a";

    const accent = localStorage.getItem("rivo-accent");
    if (accent) document.documentElement.style.setProperty("--accent", accent);

    setTimeout(() => {
        (async () => {
            try {
                const res = await fetch('/api/users/me', { credentials: 'include' });
                // replace(): "back" must not return to this loading screen;
                // the query (a notification's chat) is passed on
                if (res.ok) {
                    window.location.replace('/chat/main.html' + window.location.search);
                } else {
                    window.location.replace('/auth/auth.html');
                }
            } catch (e) {
                window.location.replace('/auth/auth.html');
            }
        })();
    }, 1600);
});
