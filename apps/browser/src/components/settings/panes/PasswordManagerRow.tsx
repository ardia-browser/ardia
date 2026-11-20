import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { usePlugins } from "../../../state/plugins/store";
import { choicePlugin, type ManagerPlugin, type PasswordManagerChoice } from "../../../state/site/passwordManagerChoice";
import { choosePasswordManagerChecked, useManagerPlugins, useProfilePasswordManager, useProfilesSharingChoice, useStoredPasswordManager } from "../../../state/site/passwordManager";
import { type Option, PopUp } from "../../ui";
import { Row } from "../Form";
import { vaultsSupported } from "../../../state/vaults/enabled";
import { useArdiaSources, type ArdiaSources } from "../../../state/vaults/ardiaSources";
import { useOwnerCheckNote } from "./PasswordManagers";

type StoredPlugin = { title: string; installed: boolean } | null;

export function managerPopUp(plugins: readonly ManagerPlugin[], stored: PasswordManagerChoice | undefined, effective: PasswordManagerChoice, storedPlugin: StoredPlugin): { value: PasswordManagerChoice; options: Option<PasswordManagerChoice>[] } {
  const offPlugin = stored !== undefined && stored !== effective && choicePlugin(stored) !== null ? stored : null;
  return {
    value: offPlugin ?? effective,
    options: [
      { value: "ardia", title: "Ardia" },
      ...plugins.map((p) => ({ value: `plugin:${p.name}` as PasswordManagerChoice, title: p.title })),
      ...(offPlugin ? [{ value: offPlugin, title: `${storedPlugin?.title ?? choicePlugin(offPlugin)} (${storedPlugin?.installed === false ? "not installed" : "off"})` }] : []),
      { value: "none", title: "None (an extension handles logins)", separatorBefore: true },
    ],
  };
}

function sharedChoiceNote(names: string[]): string | null {
  if (!names.length) return null;
  const others = names.length === 1 ? names[0]! : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} others`;
  return `Also applies to ${others}, which ${names.length === 1 ? "shares" : "share"} this profile's browser data.`;
}

function useStoredPlugin(stored: PasswordManagerChoice | undefined): StoredPlugin {
  const name = stored ? choicePlugin(stored) : null;
  const title = usePlugins((p) => (name ? (p.listings[name]?.manifest?.title ?? name) : null));
  const installed = usePlugins((p) => !!name && !!p.listings[name]);
  return name && title ? { title, installed } : null;
}

export function unavailableNote(stored: PasswordManagerChoice | undefined, effective: PasswordManagerChoice, storedPlugin: StoredPlugin): string | null {
  if (!stored || !choicePlugin(stored) || stored === effective || !storedPlugin) return null;
  if (!storedPlugin.installed) return `${storedPlugin.title} isn't installed, so this profile uses Ardia. Pick another password manager, or install it again.`;
  return `${storedPlugin.title} is off, so this profile uses Ardia until you turn it back on in Plugins or pick another password manager.`;
}

const joinedNames = (names: readonly string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

export function ardiaSourcesNote(effective: PasswordManagerChoice, sources: ArdiaSources): string | null {
  if (!vaultsSupported || effective !== "ardia" || !sources.managers.length) return null;
  return `Fills from ${joinedNames(sources.saved ? ["saved passwords", ...sources.managers] : sources.managers)}.`;
}

export function PasswordManagerRow({ profileId }: { profileId: string }) {
  return PLATFORM_FEATURES.systemPasswordManagers && PLATFORM_FEATURES.plugins ? <PasswordManagerChoiceRow profileId={profileId} /> : null;
}

function PasswordManagerChoiceRow({ profileId }: { profileId: string }) {
  const plugins = useManagerPlugins();
  const effective = useProfilePasswordManager(profileId);
  const stored = useStoredPasswordManager(profileId);
  const sharing = useProfilesSharingChoice(profileId);
  const storedPlugin = useStoredPlugin(stored);
  const unavailable = unavailableNote(stored, effective, storedPlugin);
  const popUp = managerPopUp(plugins, stored, effective, storedPlugin);
  const sources = useArdiaSources(profileId);
  const { note, guard } = useOwnerCheckNote();
  const description = note ?? ([ardiaSourcesNote(effective, sources), unavailable, sharedChoiceNote(sharing)].filter(Boolean).join(" ") || undefined);
  const choose = (manager: PasswordManagerChoice) => void guard(() => choosePasswordManagerChecked(profileId, manager));
  return (
    <Row anchor="profiles.passwordManager" description={description}>
      <PopUp value={popUp.value} options={popUp.options} onChange={choose} minWidth={210} />
    </Row>
  );
}

export function offerToSaveHandedOver(effective: PasswordManagerChoice, plugins: readonly ManagerPlugin[]): string | null {
  if (effective === "ardia") return null;
  if (effective === "none") return "Your password manager extension handles logins in this profile, so Ardia doesn't offer to save them.";
  const plugin = plugins.find((p) => `plugin:${p.name}` === effective);
  return `${plugin?.title ?? "Another password manager"} handles logins in this profile, so Ardia doesn't offer to save them. Logins already saved in Ardia still fill.`;
}
