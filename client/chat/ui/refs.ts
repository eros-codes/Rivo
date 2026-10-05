// Elements that more than one component needs to know about.
import { createRef } from "react";

/** The search results list (a tap there must not close the search). */
export const searchResultsRef = createRef<HTMLDivElement>();

/** The bar at the bottom of the open chat (message box, toolbar…): the toast sits above it. */
export const bottomBarRef: { current: HTMLElement | null } = { current: null };
