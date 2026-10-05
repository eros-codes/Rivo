// The sign-in page.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./auth.css";
import { AuthApp } from "./AuthApp";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<AuthApp />
	</StrictMode>,
);
