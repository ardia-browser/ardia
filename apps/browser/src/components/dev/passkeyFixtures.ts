import { focusedWindowId, currentWindow } from "../../state/browser/current";
import { endPasskeySheetPreview, previewPasskeySheet, type PasskeySheet } from "../../state/vaults/passkeyStore";
import { previewSystemRoute, type SystemRoute } from "../../state/vaults/passkeyRoutes";
import { troubleText } from "../../state/vaults/passkeyCopy";
import { systemRowId } from "../../state/vaults/passkeyTarget";
import { showPreviewProviders } from "../../state/vaults/store";
import type { VaultProviderState } from "../../state/vaults/actions";
import { showVaultScene, VAULT_SCENES } from "./vaultFixtures";

const PROTON_EXTENSION = "ghmbeldphafepmbegfdlkpapadhbakde";
const ORIGIN = "https://github.com";

const withRoutes = (provider: VaultProviderState, passkeysVia: NonNullable<VaultProviderState["capabilities"]["passkeysVia"]>, state: VaultProviderState["state"]) => ({
  ...provider,
  state,
  account: "sam@example.com",
  capabilities: { ...provider.capabilities, passkeysVia },
});

function managers(): VaultProviderState[] {
  const [onePassword, , proton] = VAULT_SCENES.all!.providers as VaultProviderState[];
  return [withRoutes(onePassword!, [{ via: "system" }], "unlocked"), withRoutes(proton!, [{ via: "extension", extensions: [PROTON_EXTENSION] }], "locked")];
}

export function showPasskeyManagers(route: SystemRoute) {
  showVaultScene("none");
  showPreviewProviders(managers());
  previewSystemRoute(route);
}

const base = (kind: "get" | "create"): PasskeySheet => ({
  tabId: "",
  requestId: `preview-${kind}`,
  kind,
  conditional: false,
  origin: ORIGIN,
  rpId: "github.com",
  passkeys: [],
  system: true,
  private: false,
  seq: Date.now(),
  selected: null,
  busy: false,
  error: null,
  target: "ardia",
  targets: ["ardia"],
  targetNote: null,
});

const SHEETS: Record<string, (sheet: PasskeySheet) => PasskeySheet> = {
  signInSystem: (s) => ({
    ...s,
    passkeys: [{ id: "a1", provider: "ardia", rpId: "github.com", userName: "sam@example.com", displayName: "Sam" }],
    delegates: [{ provider: "1password", via: "system" }],
    selected: systemRowId("1password"),
  }),
  signInSystemOnly: (s) => ({ ...s, delegates: [{ provider: "1password", via: "system" }], selected: systemRowId("1password") }),
  signInExtension: (s) => ({
    ...s,
    passkeys: [
      { id: "p1", provider: "protonpass", rpId: "github.com", userName: "sam@example.com", displayName: "", delegated: true },
      { id: "p2", provider: "protonpass", rpId: "github.com", userName: "work@example.com", displayName: "", delegated: true },
    ],
    delegates: [{ provider: "protonpass", via: "extension" }],
    selected: "p1",
  }),
  signInReturned: (s) => ({
    ...SHEETS.signInExtension!(s),
    error: troubleText("returned", false, "Proton Pass", "github.com"),
  }),
  saveSystem: (s) => ({ ...s, kind: "create", userName: "sam@example.com", delegates: [{ provider: "1password", via: "system" }], target: "1password", targets: ["ardia", "1password"] }),
  saveExtension: (s) => ({ ...s, kind: "create", userName: "sam@example.com", delegates: [{ provider: "protonpass", via: "extension" }], target: "protonpass", targets: ["ardia", "protonpass"] }),
};

export const PASSKEY_SHEETS = Object.keys(SHEETS);

export function showPasskeySheet(name: string) {
  const make = SHEETS[name];
  if (!make) throw new Error(`No passkey sheet ${name}: ${PASSKEY_SHEETS.join(", ")}`);
  showPreviewProviders(managers());
  const windowId = focusedWindowId();
  const window = windowId ? currentWindow(windowId) : undefined;
  const tabId = window ? window.activeTabIds[window.profileId] : undefined;
  if (!tabId) throw new Error("No active tab");
  const sheet = make({ ...base("get"), tabId, kind: "get" });
  previewPasskeySheet({ ...sheet, tabId });
  return windowId;
}

export function endPasskeyPreview() {
  endPasskeySheetPreview();
  previewSystemRoute(null);
  showPreviewProviders(null);
}
