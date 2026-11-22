import { MENU_SLOTS, type PluginManifest } from "../../lib/pluginManifest";
import type { PasswordField } from "../../lib/pluginPasswordManager";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { contributionLines } from "./consentContributions";

export type ConsentLine = { icon: string; text: string };

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

function permissionLines(m: PluginManifest): ConsentLine[] {
  const p = m.permissions;
  const lines: ConsentLine[] = [];
  if (p.control) lines.push({ icon: "hand.raised", text: "Lets any program you run drive your tabs and pages, with your logins, while control is on in Settings › Advanced" });
  lines.push(...networkLines(m));
  if (p.tabs) lines.push({ icon: "square.on.square", text: `${p.fullUrls ? "Sees the full address and title of your tabs" : "Sees the address (without what follows ? or #) and title of your tabs"}${p.tabs === "write" ? ", and can open, close and switch tabs" : ""}` });
  if (p.workspace) lines.push({ icon: "square.grid.2x2", text: "Sees and rearranges every window, tab and group: it can move, close and group your tabs" });
  if (p.activePage) lines.push({ icon: "text.magnifyingglass", text: "Reads the text of the tab you're on, for 30 seconds after you use it. Never in private windows" });
  if (m.hooks.length) lines.push({ icon: "bell", text: `Hears these events: ${m.hooks.join(", ")}` });
  if (p.commands) lines.push({ icon: "command", text: "Runs Ardia commands, like opening and closing tabs" });
  if (p.storage) lines.push({ icon: "internaldrive", text: "Keeps its own data on this " + PLATFORM_TERMS.computer });
  if (p.secrets) lines.push({ icon: "key", text: "Keeps secrets, like sign-in tokens, in your Keychain" });
  return lines;
}

export type ConsentContext = { controlOff?: boolean; official?: boolean; movesProfiles?: number };

export const CONTROL_OFF_LINE = "Control is off, as you set it, and installing this leaves it off. To let programs drive Ardia, turn on “Let programs control Ardia” in Settings › Advanced";

export function consentLines(m: PluginManifest, context: ConsentContext = {}): ConsentLine[] {
  const lines: ConsentLine[] = [...runtimeLines(m), ...permissionLines(m)];
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
  return lines;
}
