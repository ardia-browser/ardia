import type { PluginManifest } from "../../lib/pluginManifest";
import { PLATFORM_TERMS } from "../../lib/platformTerms";

type ConsentLine = { icon: string; text: string };

export const OUTSIDE_SANDBOX = "Runs outside Ardia's sandbox";

const LEVELS: Record<string, Record<string, string>> = {
  bookmarks: { read: "Reads your bookmarks", write: "Reads and changes your bookmarks" },
  history: { read: "Reads your browsing history" },
  downloads: { read: "Sees your downloads" },
  media: { read: "Sees what's playing in your tabs", control: "Sees and controls what's playing in your tabs" },
  profiles: { read: "Sees your profiles", write: "Sees your profiles and moves tabs between them" },
  clipboard: { write: "Copies to your clipboard", read: "Reads and writes your clipboard, when you use it" },
  files: { picker: "Opens and saves files you pick" },
};

const hostOf = (pattern: string) => pattern.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

export function v3Lines(m: PluginManifest): ConsentLine[] {
  const p = (m.v3.permissions ?? {}) as Record<string, unknown>;
  const lines: ConsentLine[] = [];
  if (m.programs.length || m.permissions.control) lines.push({ icon: "exclamationmark.triangle.fill", text: `${OUTSIDE_SANDBOX}: what it installs can do anything you can on this ${PLATFORM_TERMS.computer}` });
  if (Array.isArray(p.pages) && p.pages.length) lines.push({ icon: "doc.richtext", text: `Can read and change pages on ${[...new Set(p.pages.map((x) => hostOf(String(x))))].join(", ")}` });
  for (const [key, words] of Object.entries(LEVELS)) {
    const level = p[key];
    if (typeof level === "string" && words[level]) lines.push({ icon: "checkmark.shield", text: words[level]! });
  }
  if (p.notifications === true) lines.push({ icon: "bell.badge", text: "Shows notifications" });
  if (Array.isArray(p.network)) {
    const local = p.network.filter((h) => /^(?:localhost|127\.0\.0\.1):\d+$/.test(String(h)));
    for (const host of local) lines.push({ icon: "network", text: `Talks to a local app on port ${String(host).split(":")[1]}` });
  }
  const deps = Object.keys(m.dependencies);
  if (deps.length) lines.push({ icon: "shippingbox.and.arrow.backward", text: `Needs ${deps.join(", ")}, installed with it` });
  if (m.consumes.length) lines.push({ icon: "arrow.left.arrow.right", text: `Uses ${m.consumes.join(", ")} from another plugin, which never hands it that plugin's keys` });
  if (m.scope === "global") lines.push({ icon: "globe", text: "Runs once for all your profiles" });
  return lines;
}
