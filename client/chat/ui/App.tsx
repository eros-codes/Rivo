// The chat app's screen: the lists and the open chat side by side (on a
// phone the chat slides over the lists), with the panels, dialogs and
// messages to the user on top.
import { useIsPhone } from "../../shared/lib/hooks";
import { ForwardDialog } from "./chat/ForwardDialog";
import { ChatPart } from "./chat/ChatPart";
import { AddContactDialog } from "./dialogs/AddContactDialog";
import { ArchivedDialog } from "./dialogs/ArchivedDialog";
import { DeleteAccountDialog } from "./dialogs/DeleteAccountDialog";
import { DevicesDialog } from "./dialogs/DevicesDialog";
import { ConnectionStatus } from "./feedback/ConnectionStatus";
import { InAppNotifications } from "./feedback/InAppNotifications";
import { Toaster } from "./feedback/Toaster";
import { EditProfilePanel } from "./panels/EditProfilePanel";
import { ProfilePanel } from "./panels/ProfilePanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { PeoplePart } from "./people/PeoplePart";
import { useUi } from "./selectors";

export function App() {
	const phone = useIsPhone();
	const forwarding = useUi((s) => s.dialog === "forward" && s.forwarding !== null);
	return (
		<>
			<main className="parts">
				<PeoplePart phone={phone} />
				<ChatPart phone={phone} />
			</main>
			<ProfilePanel phone={phone} />
			<EditProfilePanel phone={phone} />
			<SettingsPanel phone={phone} />
			<AddContactDialog />
			<ArchivedDialog />
			<DevicesDialog />
			<DeleteAccountDialog />
			{forwarding && <ForwardDialog />}
			<InAppNotifications />
			<Toaster />
			<ConnectionStatus />
		</>
	);
}
