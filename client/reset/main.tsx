// The "choose a new password" page (from the emailed link).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../auth/auth.css";
import { ResetApp } from "./ResetApp";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ResetApp />
	</StrictMode>,
);
