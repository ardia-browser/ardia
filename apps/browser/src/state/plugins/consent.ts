import { MENU_SLOTS, type PluginManifest, type PluginPermissions } from "../../lib/pluginManifest";
import type { StateIntent, StateTopic } from "../../lib/pluginState";
import type { PasswordField } from "../../lib/pluginPasswordManager";
import { pageBarConsent } from "../../lib/pluginPageBar";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { contributionLines } from "./consentContributions";

type ConsentLine = { icon: string; text: string };

const FIELD_WORDS: Record<PasswordField, string> = { login: "login", oneTimeCode: "verification code" };

function passwordManagerLines(m: PluginManifest, context: ConsentContext): ConsentLine[] {
  const pm = m.passwordManager;
  if (!pm) return [];
  const lines: ConsentLine[] = [
    { icon: "key.fill", text: "Becomes a password manager you can pick for each profile. Profiles that use it stop offering to save passwords in Ardia" },
  ];
  const moves = context.official ? (context.movesProfiles ?? 0) : 0;
  if (moves > 0) lines.push({ icon: "person.2", text: `Moves ${moves === 1 ? "1 profile" : `${moves} profiles`} that never picked a password manager to ${m.title}` });
  const fields = pm.fields.map((f) => FIELD_WORDS[f]).join(" and ");
  lines.push({ icon: "key", text: `Shows a key in ${fields} fields on every site. It opens macOS's Passwords panel there, which fills the field; the plugin never sees what's filled` });
  if (pm.verificationCodeSetup) lines.push({ icon: "qrcode", text: "Offers to set up two-factor codes a page shows in the app macOS uses for them" });
  return lines;
}

const FULL_CONTROL_REACH = `every tab and page, your signed-in sites and their cookies, and uploads and downloads of any file on this ${PLATFORM_TERMS.computer}`;

export function fullControlLine(m: PluginManifest, context: ConsentContext = {}): ConsentLine | null {
  const afterUpdates = m.programs.some((p) => p.afterUpdate.length > 0);
  if (m.permissions.control) {
    const who = afterUpdates ? "any program you run, and the commands Ardia runs for it after updates," : "any program you run";
    const when = context.controlOff || context.installed ? "While control is on in Settings › Advanced" : "Turns on control in Settings › Advanced. While it's on";
    return { icon: "hand.raised", text: `${when}, ${who} can fully control Ardia: ${FULL_CONTROL_REACH}` };
  }
  if (!m.programs.length) return null;
  const names = m.programs.map((p) => p.name).join(" and ");
  const one = m.programs.length === 1;
  const runs = `The ${names} ${one ? "command runs" : "commands run"} as you`;
  const who = afterUpdates ? `${runs}, as do the commands Ardia runs for it after updates, so while control is on in Settings › Advanced, they` : `${runs}, so while control is on in Settings › Advanced, ${one ? "it" : "they"}`;
  return { icon: "hand.raised", text: `${who} can fully control Ardia: ${FULL_CONTROL_REACH}` };
}

export const FULL_CONTROL_SUMMARY = "Can fully control Ardia";

function runtimeLines(m: PluginManifest): ConsentLine[] {
  const lines: ConsentLine[] = [];
  if (m.main) lines.push({ icon: "shippingbox", text: m.activationEvents.some((e) => e === "*" || e === "onStartupFinished" || e.startsWith("onEvent:")) ? "Runs its code in the background, in Ardia's plugin sandbox" : "Runs its code in Ardia's plugin sandbox, starting the first time you use it and stopping when you quit Ardia or turn the plugin off" });
  if (m.sidecar) lines.push({ icon: "gearshape", text: `Runs a program in the background: ${m.sidecar.run.join(" ")}` });
  for (const p of m.programs) {
    lines.push({ icon: "terminal.fill", text: `Adds ${p.name} to your PATH. It runs as you, outside Ardia's sandbox` });
    if (p.afterUpdate.length) lines.push({ icon: "arrow.triangle.2.circlepath", text: `After updates, runs ${p.afterUpdate.map((a) => [p.name, ...a].join(" ")).join(", ")}` });
  }
  if (m.programs.length) lines.push({ icon: "doc.text", text: "Adds ~/.local/bin to your PATH in your shell's login file" });
  return lines;
}

function networkLines(m: PluginManifest): ConsentLine[] {
  const network = m.permissions.network;
  const who = m.sidecar ? "That program" : "It";
  if (network === "*") return [{ icon: "network", text: m.sidecar ? `That program may connect to the internet and to servers on this ${PLATFORM_TERMS.computer}, and a server it starts may listen on your network address` : `It may connect to any site, and to servers on this ${PLATFORM_TERMS.computer}` }];
  if (Array.isArray(network)) return [{ icon: "network", text: `Its code may connect only to ${network.join(", ")}, through Ardia. Its pages and views stay offline` }];
  if (m.sidecar || m.main) return [{ icon: "antenna.radiowaves.left.and.right.slash", text: `${who} can't connect to anything or accept connections, not even from this ${PLATFORM_TERMS.computer}` }];
  return [];
}

const TOPIC_WORDS: Record<StateTopic, string> = {
  tabs: "your tabs change",
  workspace: "your windows and groups change",
  navigation: "a tab goes to a new page",
  downloads: "a download starts, moves along or finishes",
};

const INTENT_WORDS: Record<StateIntent, string> = {
  "tabs.group": "group tabs",
  "tabs.ungroup": "ungroup tabs",
  "tabs.move": "move tabs",
  "tabs.pin": "pin tabs",
  "tabs.unpin": "unpin tabs",
  "tabs.mute": "mute tabs",
  "tabs.unmute": "unmute tabs",
  "tabs.activate": "switch tabs",
  "groups.update": "rename, recolour and fold groups",
};

function stateLines(p: PluginPermissions): ConsentLine[] {
  if (!p.state) return [];
  const lines: ConsentLine[] = [];
  if (p.state.events.length) lines.push({ icon: "dot.radiowaves.left.and.right", text: `Hears when ${p.state.events.map((t) => TOPIC_WORDS[t]).join(", when ")}. Never private windows${p.state.events.includes("downloads") ? ", private downloads or where a file was saved" : ""}` });
  if (p.state.intents.length) lines.push({ icon: "arrow.up.arrow.down.square", text: `Can ${p.state.intents.map((i) => INTENT_WORDS[i]).join(", ")}. Never in private windows` });
  return lines;
}

function permissionLines(m: PluginManifest): ConsentLine[] {
  const p = m.permissions;
  const lines: ConsentLine[] = [];
  lines.push(...networkLines(m));
  if (p.tabs) lines.push({ icon: "square.on.square", text: `${p.fullUrls ? "Sees the full address and title of your tabs" : "Sees the address (without what follows ? or #) and title of your tabs"}${p.tabs === "write" ? ", and can open, close and switch tabs" : ""}` });
  if (p.workspace) lines.push({ icon: "square.grid.2x2", text: "Sees and rearranges every window, tab and group: it can move, close and group your tabs" });
  if (p.activePage) lines.push({ icon: "text.magnifyingglass", text: "Reads the text of the tab you're on, for 30 seconds after you use it. Never in private windows" });
  if (m.hooks.length) lines.push({ icon: "bell", text: `Hears these events: ${m.hooks.join(", ")}` });
  lines.push(...stateLines(p));
  if (p.commands) lines.push({ icon: "command", text: "Runs Ardia commands, like opening and closing tabs" });
  if (p.storage) lines.push({ icon: "internaldrive", text: "Keeps its own data on this " + PLATFORM_TERMS.computer });
  if (p.secrets) lines.push({ icon: "key", text: "Keeps secrets, like sign-in tokens, in your Keychain" });
  return lines;
}

type ConsentContext = { controlOff?: boolean; official?: boolean; movesProfiles?: number; installed?: boolean };

export const CONTROL_OFF_LINE = "Control is off, as you set it, and installing this leaves it off. To let programs drive Ardia, turn on “Let programs control Ardia” in Settings › Advanced";

export function consentLines(m: PluginManifest, context: ConsentContext = {}): ConsentLine[] {
  const control = fullControlLine(m, context);
  const lines: ConsentLine[] = [...(control ? [control] : []), ...runtimeLines(m), ...permissionLines(m)];
  if (m.permissions.control && context.controlOff) lines.push({ icon: "hand.raised.slash", text: CONTROL_OFF_LINE });
  const defaults = Object.keys(m.settings.defaults);
  if (defaults.length) lines.push({ icon: "slider.horizontal.3", text: `Changes these settings while it's on: ${defaults.join(", ")}` });
  if (m.settings.rows.length) lines.push({ icon: "list.bullet", text: `Adds ${m.settings.rows.length === 1 ? "a setting" : `${m.settings.rows.length} settings`} to its page here` });
  if (m.page) lines.push({ icon: m.page.icon, text: `Adds a page you open as a tab: ${m.page.title} (ardia://${m.name})` });
  if (m.commands.some((c) => "open" in c.action && c.action.context)) lines.push({ icon: "rectangle.split.2x1", text: "Its page can be handed the tab you're on when you open it beside that tab" });
  if (m.commands.length) lines.push({ icon: "command", text: `Adds to the command bar: ${m.commands.map((c) => c.title).join(", ")}` });
  if (m.tools.length) lines.push({ icon: "wrench.and.screwdriver", text: `Offers tools to the ardia command and other plugins: ${m.tools.map((t) => t.title).join(", ")}` });
  lines.push(...contributionLines(m, MENU_SLOTS));
  lines.push(...passwordManagerLines(m, context));
  lines.push(...pageBarConsent(m.contributes.siteSwitches, m.contributes.pageBar));
  return lines;
}
