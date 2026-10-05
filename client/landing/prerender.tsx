// Used by the build: the landing and privacy pages as HTML.
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { LandingPage } from "./LandingPage";
import { PrivacyPage } from "./PrivacyPage";

export function render(): { landing: string; privacy: string } {
	return {
		landing: renderToString(
			<StrictMode>
				<LandingPage />
			</StrictMode>,
		),
		privacy: renderToString(
			<StrictMode>
				<PrivacyPage />
			</StrictMode>,
		),
	};
}
