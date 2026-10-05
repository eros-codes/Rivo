// The landing and privacy pages come as finished HTML (rendered at build
// time); this brings them to life.
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import "./landing.css";
import "./privacy.css";
import { LandingPage } from "./LandingPage";
import { PrivacyPage } from "./PrivacyPage";

const root = document.getElementById("root")!;
hydrateRoot(root, <StrictMode>{root.dataset.page === "privacy" ? <PrivacyPage /> : <LandingPage />}</StrictMode>);
