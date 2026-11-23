import { MENU_SLOTS, type PluginManifest } from "../../lib/pluginManifest";
import type { PasswordField } from "../../lib/pluginPasswordManager";
import { pageBarConsent } from "../../lib/pluginPageBar";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { contributionLines } from "./consentContributions";
import { credentialProviderLines } from "./consentCredentials";
import { CONSENT_GROUP_ORDER, consentLine, type ConsentLine } from "./consentLine";

export type { ConsentGroup, ConsentLine } from "./consentLine";

const FIELD_WORDS: Record<PasswordField, string> = { login: "login", oneTimeCode: "verification code" };

function passwordManagerLines(m: PluginManifest, context: ConsentContext): ConsentLine[] {
  const pm = m.passwordManager;
  if (!pm) return [];
  const lines: ConsentLine[] = [consentLine("does", "key.fill", "Becomes a password manager you can pick per profile", { detail: "Profiles that use it stop offering to save passwords in Ardia" })];
  const moves = context.official ? (context.movesProfiles ?? 0) : 0;
  if (moves > 0) lines.push(consentLine("does", "person.2", `Moves ${moves === 1 ? "1 profile" : `${moves} profiles`} to ${m.title}`, { detail: moves === 1 ? "It never picked a password manager" : "They never picked a password manager" }));
  const fields = pm.fields.map((f) => FIELD_WORDS[f]).join(" and ");
  lines.push(consentLine("does", "key", `Shows a key in ${fields} fields on every site`, { detail: "It opens macOS's Passwords panel, which fills the field. The plugin never sees what's filled" }));
  if (pm.verificationCodeSetup) lines.push(consentLine("does", "qrcode", "Offers to set up two-factor codes", { detail: "When a page shows one, in the app macOS uses for them" }));
  return lines;
}

const runsInBackground = (m: PluginManifest) => m.activationEvents.some((e) => e === "*" || e === "onStartupFinished" || e.startsWith("onEvent:"));

function runtimeLines(m: PluginManifest): ConsentLine[] {
  if (!m.main) return [];
  return [
    runsInBackground(m)
      ? consentLine("limits", "shippingbox", "Runs in the background", { detail: "Inside Ardia's plugin sandbox" })
      : consentLine("limits", "shippingbox", "Runs when you use it", { detail: "Inside Ardia's plugin sandbox, until you quit Ardia or turn the plugin off" }),
  ];
}

function programLines(m: PluginManifest): ConsentLine[] {
  const lines: ConsentLine[] = [];
  if (m.sidecar) lines.push(consentLine("reaches", "gearshape", "Runs a program in the background", { items: [m.sidecar.run.join(" ")], code: true }));
  for (const p of m.programs) {
    lines.push(consentLine("reaches", "terminal.fill", `Adds ${p.name} to your PATH`, { detail: "It runs as you, outside Ardia's sandbox" }));
    if (p.afterUpdate.length) lines.push(consentLine("reaches", "arrow.triangle.2.circlepath", "Runs these after each update", { items: p.afterUpdate.map((a) => [p.name, ...a].join(" ")), code: true }));
  }
  if (m.programs.length) lines.push(consentLine("reaches", "doc.text", "Adds ~/.local/bin to your PATH", { detail: "In your shell's login file" }));
  return lines;
}

function networkLines(m: PluginManifest): ConsentLine[] {
  const network = m.permissions.network;
  const computer = PLATFORM_TERMS.computer;
  if (network === "*")
    return [
      m.sidecar
        ? consentLine("reaches", "network", "Its program can connect to the internet", { detail: `And to servers on this ${computer}. A server it starts may listen on your network address` })
        : consentLine("reaches", "network", "Can connect to any site", { detail: `And to servers on this ${computer}` }),
    ];
  if (Array.isArray(network)) return [consentLine("reaches", "network", "Can connect only to these sites", { items: network, code: true, detail: "Through Ardia. Its pages and views stay offline" })];
  if (m.sidecar || m.main) return [consentLine("limits", "antenna.radiowaves.left.and.right.slash", m.sidecar ? "Its program can't connect to anything" : "Can't connect to anything", { detail: `Nor accept connections, even from this ${computer}` })];
  return [];
}

function tabsLine(fullUrls: boolean, writes: boolean): ConsentLine {
  const sees = fullUrls ? "Their full address and title" : "Their address, without what follows ? or #, and title";
  return consentLine("reaches", "square.on.square", writes ? "Sees and changes your tabs" : "Sees your tabs", { detail: writes ? `${sees}. It can open, close and switch tabs` : sees });
}

function permissionLines(m: PluginManifest, context: ConsentContext): ConsentLine[] {
  const p = m.permissions;
  const lines: ConsentLine[] = [];
  if (p.control) lines.push(consentLine("reaches", "hand.raised", "Lets any program you run drive your tabs and pages", { detail: "With your logins, while control is on in Settings › Advanced" }));
  if (p.control && context.controlOff) lines.push(CONTROL_OFF);
  lines.push(...networkLines(m));
  if (p.tabs) lines.push(tabsLine(p.fullUrls, p.tabs === "write"));
  if (p.workspace) lines.push(consentLine("reaches", "square.grid.2x2", "Sees and rearranges every window, tab and group", { detail: "It can move, close and group your tabs" }));
  if (p.activePage) lines.push(consentLine("reaches", "text.magnifyingglass", "Reads the text of the tab you're on", { detail: "For 30 seconds after you use it. Never in private windows" }));
  if (m.hooks.length) lines.push(consentLine("reaches", "bell", "Hears these events", { items: m.hooks, code: true }));
  if (p.commands) lines.push(consentLine("reaches", "command", "Runs Ardia commands", { detail: "Like opening and closing tabs" }));
  if (p.storage) lines.push(consentLine("reaches", "internaldrive", `Keeps its own data on this ${PLATFORM_TERMS.computer}`));
  if (p.secrets) lines.push(consentLine("reaches", "key", "Keeps secrets in your Keychain", { detail: "Like sign-in tokens" }));
  return lines;
}

function addedLines(m: PluginManifest): ConsentLine[] {
  const lines: ConsentLine[] = [];
  const defaults = Object.keys(m.settings.defaults);
  if (defaults.length) lines.push(consentLine("does", "slider.horizontal.3", "Changes these settings while it's on", { items: defaults, code: true }));
  if (m.settings.rows.length) lines.push(consentLine("does", "list.bullet", `Adds ${m.settings.rows.length === 1 ? "a setting" : `${m.settings.rows.length} settings`} to its page here`));
  if (m.page) lines.push(consentLine("does", m.page.icon, `Adds the ${m.page.title} page`, { items: [`ardia://${m.name}`], code: true, detail: "You open it as a tab" }));
  if (m.commands.some((c) => "open" in c.action && c.action.context)) lines.push(consentLine("reaches", "rectangle.split.2x1", "Its page can be handed the tab you're on", { detail: "When you open it beside that tab" }));
  if (m.commands.length) lines.push(consentLine("does", "command", "Adds to the command bar", { items: m.commands.map((c) => c.title) }));
  if (m.tools.length) lines.push(consentLine("does", "wrench.and.screwdriver", "Offers tools to the ardia command and other plugins", { items: m.tools.map((t) => t.title) }));
  return lines;
}

export type ConsentContext = { controlOff?: boolean; official?: boolean; movesProfiles?: number };

const CONTROL_OFF = consentLine("limits", "hand.raised.slash", "Control stays off, as you set it", { detail: "Installing this leaves it off. To let programs drive Ardia, turn on “Let programs control Ardia” in Settings › Advanced" });

export const CONTROL_OFF_LINE = CONTROL_OFF.text;

export function consentLines(m: PluginManifest, context: ConsentContext = {}): ConsentLine[] {
  const lines: ConsentLine[] = [
    ...programLines(m),
    ...credentialProviderLines(m.contributes.credentialProvider),
    ...permissionLines(m, context),
    ...runtimeLines(m),
    ...addedLines(m),
    ...contributionLines(m, MENU_SLOTS),
    ...passwordManagerLines(m, context),
    ...pageBarConsent(m.contributes.siteSwitches, m.contributes.pageBar).map((l) => consentLine("does", l.icon, l.text)),
  ];
  return CONSENT_GROUP_ORDER.flatMap((group) => lines.filter((l) => l.group === group));
}
