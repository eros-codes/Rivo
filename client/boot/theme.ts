// Runs in <head> before anything is drawn: the stored theme, accent and chat
// background, so the page never flashes the wrong colors.
import { applyStoredAppearance } from "../shared/lib/theme";

try {
	applyStoredAppearance();
} catch {
	/* storage blocked: the default look */
}
