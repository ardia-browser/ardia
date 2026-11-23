import { at, KEY, KEY_RULE, list, matching, object, only, symbolOf, text, unique, type Check } from "./pluginChecks";
import { urlParts } from "./urlParts";

export const HOST_ACTIONS = {
  siteControls: { title: "Site Controls", consent: "open Site Controls" },
  address: { title: "Edit Address", consent: "edit the address" },
  copyLink: { title: "Copy URL", consent: "copy the page address" },
  console: { title: "Toggle Console", consent: "open the Console" },
  network: { title: "Toggle Network Panel", consent: "open the Network panel" },
  inspect: { title: "Inspect Element", consent: "inspect an element" },
  extensions: { title: "Extensions", consent: "run your extensions" },
  split: { title: "Split View Options", consent: "add a split" },
} as const;
export type HostAction = keyof typeof HOST_ACTIONS;
export const HOST_ACTION_NAMES = Object.keys(HOST_ACTIONS) as HostAction[];
export const BUTTON_DIVIDER = "|";
export type PageBarButton = HostAction | typeof BUTTON_DIVIDER;
export const PAGE_BAR_LOOKS = ["stripes"] as const;
type PageBarLook = (typeof PAGE_BAR_LOOKS)[number];

export const PAGE_BAR_LIMITS = { siteSwitches: 4, buttons: 16, switchTitle: 40 } as const;

export type SiteSwitchSpec = { key: string; title: string; icon: string };
export type PageBarSpec = { look: PageBarLook; when: { siteSwitch: string | null; localAddresses: string | null }; buttons: PageBarButton[] };

const isHostAction = (value: unknown): value is HostAction => typeof value === "string" && Object.hasOwn(HOST_ACTIONS, value);

type RowRef = { key: string; type: string };

const P = "contributes";

export function siteSwitchesOf(c: Check, value: unknown): SiteSwitchSpec[] {
  const path = `${P}.siteSwitches`;
  const out = list(c, path, value, PAGE_BAR_LIMITS.siteSwitches).flatMap((raw, i): SiteSwitchSpec[] => {
    const at_ = at(path, i);
    const doc = object(c, at_, raw);
    if (!doc) return [];
    only(c, at_, doc, ["key", "title", "icon"]);
    const key = matching(c, `${at_}.key`, doc.key, KEY, KEY_RULE);
    const title = text(c, `${at_}.title`, doc.title, PAGE_BAR_LIMITS.switchTitle);
    const icon = symbolOf(c, `${at_}.icon`, doc.icon);
    return key && title ? [{ key, title, icon }] : [];
  });
  unique(c, path, out.map((s) => s.key), "switches");
  return out;
}

function buttonsOf(c: Check, value: unknown): PageBarButton[] {
  const path = `${P}.pageBar.buttons`;
  if (!Array.isArray(value) || value.length < 1 || value.length > PAGE_BAR_LIMITS.buttons) {
    c.problems.push(`${path} must be a list of 1 to ${PAGE_BAR_LIMITS.buttons}`);
    return [];
  }
  const out: PageBarButton[] = [];
  value.forEach((b, i) => {
    if (b === BUTTON_DIVIDER) return void out.push(BUTTON_DIVIDER);
    if (!isHostAction(b)) return void c.problems.push(`${at(path, i)} must be ${BUTTON_DIVIDER} or one of ${HOST_ACTION_NAMES.join(", ")}`);
    if (out.includes(b)) return void c.problems.push(`${path} has ${b} twice`);
    out.push(b);
  });
  if (out.length && !out.some(isHostAction)) c.problems.push(`${path} needs at least one action besides ${BUTTON_DIVIDER}`);
  return out;
}

export function pageBarOf(c: Check, value: unknown, switches: SiteSwitchSpec[], rows: readonly RowRef[]): PageBarSpec | null {
  const path = `${P}.pageBar`;
  if (value === undefined) return null;
  const doc = object(c, path, value);
  if (!doc) return null;
  only(c, path, doc, ["look", "when", "buttons"]);
  const look = (PAGE_BAR_LOOKS as readonly unknown[]).includes(doc.look) ? (doc.look as PageBarLook) : (c.problems.push(`${path}.look must be ${PAGE_BAR_LOOKS.join(" or ")}`), null);
  const when = object(c, `${path}.when`, doc.when) ?? {};
  only(c, `${path}.when`, when, ["siteSwitch", "localAddresses"]);
  const siteSwitch = typeof when.siteSwitch === "string" && switches.some((s) => s.key === when.siteSwitch) ? when.siteSwitch : null;
  if (siteSwitch === null) c.problems.push(`${path}.when.siteSwitch must name one of this plugin's siteSwitches`);
  let localAddresses: string | null = null;
  if (when.localAddresses !== undefined) {
    if (typeof when.localAddresses === "string" && rows.some((r) => r.key === when.localAddresses && r.type === "toggle")) localAddresses = when.localAddresses;
    else c.problems.push(`${path}.when.localAddresses must name one of this plugin's toggle rows`);
  }
  const buttons = buttonsOf(c, doc.buttons);
  return look && siteSwitch && buttons.some(isHostAction) ? { look, when: { siteSwitch, localAddresses }, buttons } : null;
}

export function switchOrigin(url: string): string | null {
  const parts = urlParts(url);
  if (!parts || (parts.scheme !== "http" && parts.scheme !== "https") || !parts.host) return null;
  const host = parts.host.replace(/\.$/, "");
  return host ? `${parts.scheme}://${host}${parts.port ? `:${parts.port}` : ""}` : null;
}

const LOCAL_HOST = /^(?:localhost|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/;

export function isLocalOrigin(origin: string): boolean {
  const host = origin.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
  return LOCAL_HOST.test(host);
}

export function pageBarConsent(switches: SiteSwitchSpec[], bar: PageBarSpec | null): { icon: string; text: string }[] {
  const lines: { icon: string; text: string }[] = [];
  if (switches.length) lines.push({ icon: switches[0]!.icon, text: `Adds ${switches.length === 1 ? `a ${switches[0]!.title} switch` : `switches (${switches.map((s) => s.title).join(", ")})`} to Site Controls, for each site` });
  if (!bar) return lines;
  const verbs = bar.buttons.filter(isHostAction).map((b) => HOST_ACTIONS[b].consent);
  const list = verbs.length > 1 ? `${verbs.slice(0, -1).join(", ")} and ${verbs.at(-1)}` : verbs[0]!;
  const title = switches.find((s) => s.key === bar.when.siteSwitch)?.title ?? "it";
  lines.push({ icon: "menubar.rectangle", text: `Shows a striped bar on sites where ${title} is on, with buttons to ${list}` });
  if (bar.when.localAddresses) lines.push({ icon: "desktopcomputer", text: `With one of its settings on, a local address you type in (like localhost) turns ${title} on for that site` });
  return lines;
}
