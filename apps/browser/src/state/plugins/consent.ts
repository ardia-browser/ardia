import type { PluginManifest } from "../../lib/pluginManifest";
import type { PasswordField } from "../../lib/pluginPasswordManager";
import { pageBarConsent } from "../../lib/pluginPageBar";
import { PLATFORM_TERMS } from "../../lib/platformTerms";

export type ConsentLine = { icon: string; text: string };

export type ConsentContext = { bundled?: boolean; movesProfiles?: number };

const FIELD_WORDS: Record<PasswordField, string> = { login: "login", oneTimeCode: "verification code" };

function passwordManagerLines(m: PluginManifest, context: ConsentContext): ConsentLine[] {
  const pm = m.passwordManager;
  if (!pm) return [];
  const lines: ConsentLine[] = [
    { icon: "key.fill", text: "Becomes a password manager you can pick for each profile. Profiles that use it stop offering to save passwords in Ardia" },
  ];
  const moves = context.bundled ? (context.movesProfiles ?? 0) : 0;
  if (moves > 0) lines.push({ icon: "person.2", text: `Moves ${moves === 1 ? "1 profile" : `${moves} profiles`} that never picked a password manager to ${m.title}` });
  const fields = pm.fields.map((f) => FIELD_WORDS[f]).join(" and ");
  lines.push({ icon: "key", text: `Shows a key in ${fields} fields on every site. It opens macOS's Passwords panel there, which fills the field; the plugin never sees what's filled` });
  if (pm.verificationCodeSetup) lines.push({ icon: "qrcode", text: "Offers to set up two-factor codes a page shows in the app macOS uses for them" });
  if (pm.passkeys) lines.push({ icon: "person.badge.key", text: `Shows whether Ardia may use passkeys saved on this ${PLATFORM_TERMS.computer}, and can ask macOS for access` });
  return lines;
}

export function consentLines(m: PluginManifest, context: ConsentContext = {}): ConsentLine[] {
  const lines: ConsentLine[] = [];
  if (m.process) lines.push({ icon: "gearshape", text: `Runs a program in the background: ${m.process.run.join(" ")}` });
  for (const p of m.programs) {
    lines.push({ icon: "terminal.fill", text: `Adds ${p.name} to your PATH. It runs as you, outside Ardia's sandbox` });
    if (p.afterUpdate.length) lines.push({ icon: "arrow.triangle.2.circlepath", text: `After updates, runs ${p.afterUpdate.map((a) => [p.name, ...a].join(" ")).join(", ")}` });
  }
  if (m.programs.length) lines.push({ icon: "doc.text", text: "Adds ~/.local/bin to your PATH in your shell's login file" });
  const control = m.permissions.includes("control");
  if (control) lines.push({ icon: "hand.raised", text: m.alwaysOn ? "Lets any program you run drive your tabs and pages, with your logins, while it's installed. There's no off switch" : "Lets any program you run drive your tabs and pages, with your logins" });
  else if (m.alwaysOn) lines.push({ icon: "lock", text: "Once installed, there's no off switch" });
  if (m.permissions.includes("network")) lines.push({ icon: "network", text: `That program may connect to the internet and to servers on this ${PLATFORM_TERMS.computer}, and a server it starts may listen on your network address` });
  else if (m.process) lines.push({ icon: "antenna.radiowaves.left.and.right.slash", text: `That program can't connect to anything or accept connections, not even from this ${PLATFORM_TERMS.computer}` });
  if (m.permissions.includes("tabs")) lines.push({ icon: "square.on.square", text: m.permissions.includes("fullUrls") ? "Sees the full address and title of your tabs" : "Sees the address (without what follows ? or #) and title of your tabs" });
  if (m.hooks.length) lines.push({ icon: "bell", text: `Hears these events: ${m.hooks.join(", ")}` });
  if (m.permissions.includes("commands")) lines.push({ icon: "command", text: "Runs Ardia commands, like opening and closing tabs" });
  const defaults = Object.keys(m.settings.defaults);
  if (defaults.length) lines.push({ icon: "slider.horizontal.3", text: `Changes these settings while it's on: ${defaults.join(", ")}` });
  if (m.settings.rows.length) lines.push({ icon: "list.bullet", text: `Adds ${m.settings.rows.length === 1 ? "a setting" : `${m.settings.rows.length} settings`} to its page here` });
  if (m.page) lines.push({ icon: m.page.icon, text: `Adds a page you open as a tab: ${m.page.title} (ardia://${m.name})` });
  if (m.commands.some((c) => "open" in c.action && c.action.context)) lines.push({ icon: "rectangle.split.2x1", text: "Its page can be handed the tab you're on when you open it beside that tab" });
  if (m.commands.length) lines.push({ icon: "command", text: `Adds to the command bar: ${m.commands.map((c) => c.title).join(", ")}` });
  if (m.tools.length) lines.push({ icon: "wrench.and.screwdriver", text: `Offers tools to the ardia command and other plugins: ${m.tools.map((t) => t.title).join(", ")}` });
  lines.push(...passwordManagerLines(m, context));
  lines.push(...pageBarConsent(m.siteSwitches, m.pageBar));
  return lines;
}
