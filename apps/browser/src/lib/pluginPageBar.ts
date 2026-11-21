import { isFields } from "./decode";
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
export type PageBarLook = (typeof PAGE_BAR_LOOKS)[number];

export const PAGE_BAR_LIMITS = { siteSwitches: 4, buttons: 16, switchTitle: 40 } as const;

export type SiteSwitchSpec = { key: string; title: string; icon: string };
export type PageBarSpec = { look: PageBarLook; when: { siteSwitch: string | null; localAddresses: string | null }; buttons: PageBarButton[] };

export const isHostAction = (value: unknown): value is HostAction => typeof value === "string" && Object.hasOwn(HOST_ACTIONS, value);

type RowRef = { key: string; type: string };
type Shape = { key: RegExp; symbol: RegExp; title: (path: string, value: unknown, max: number) => string | null };

export function siteSwitchesOf(problems: string[], value: unknown, shape: Shape): SiteSwitchSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PAGE_BAR_LIMITS.siteSwitches) {
    problems.push(`siteSwitches must be a list of at most ${PAGE_BAR_LIMITS.siteSwitches}`);
    return [];
  }
  const out: SiteSwitchSpec[] = [];
  value.forEach((raw, i) => {
    const path = `siteSwitches[${i}]`;
    if (!isFields(raw)) return void problems.push(`${path} must be an object`);
    for (const k of Object.keys(raw)) if (!["key", "title", "icon"].includes(k)) problems.push(`${path}.${k} isn't a key of ${path}`);
    const key = typeof raw.key === "string" && shape.key.test(raw.key) ? raw.key : (problems.push(`${path}.key must be 1 to 40 letters, digits, - and _`), null);
    const title = shape.title(`${path}.title`, raw.title, PAGE_BAR_LIMITS.switchTitle);
    const icon = raw.icon === undefined ? "puzzlepiece" : typeof raw.icon === "string" && shape.symbol.test(raw.icon) ? raw.icon : (problems.push(`${path}.icon must be an SF Symbol name`), null);
    if (key && out.some((s) => s.key === key)) return void problems.push(`siteSwitches has two switches named ${key}`);
    if (key && title && icon) out.push({ key, title, icon });
  });
  return out;
}

function buttonsOf(problems: string[], value: unknown): PageBarButton[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > PAGE_BAR_LIMITS.buttons) {
    problems.push(`pageBar.buttons must be a list of 1 to ${PAGE_BAR_LIMITS.buttons}`);
    return [];
  }
  const out: PageBarButton[] = [];
  value.forEach((b, i) => {
    if (b === BUTTON_DIVIDER) return void out.push(BUTTON_DIVIDER);
    if (!isHostAction(b)) return void problems.push(`pageBar.buttons[${i}] must be ${BUTTON_DIVIDER} or one of ${HOST_ACTION_NAMES.join(", ")}`);
    if (out.includes(b)) return void problems.push(`pageBar.buttons has ${b} twice`);
    out.push(b);
  });
  if (out.length && !out.some(isHostAction)) problems.push("pageBar.buttons needs at least one action besides |");
  return out;
}

export function pageBarOf(problems: string[], value: unknown, switches: SiteSwitchSpec[], rows: RowRef[]): PageBarSpec | null {
  if (value === undefined) return null;
  if (!isFields(value)) return void problems.push("pageBar must be an object"), null;
  for (const k of Object.keys(value)) if (!["look", "when", "buttons"].includes(k)) problems.push(`pageBar.${k} isn't a key of pageBar`);
  const look = (PAGE_BAR_LOOKS as readonly unknown[]).includes(value.look) ? (value.look as PageBarLook) : (problems.push(`pageBar.look must be ${PAGE_BAR_LOOKS.join(" or ")}`), null);
  const when = isFields(value.when) ? value.when : (problems.push("pageBar.when must be an object"), {});
  for (const k of Object.keys(when)) if (!["siteSwitch", "localAddresses"].includes(k)) problems.push(`pageBar.when.${k} isn't a key of pageBar.when`);
  const siteSwitch = typeof when.siteSwitch === "string" && switches.some((s) => s.key === when.siteSwitch) ? when.siteSwitch : null;
  if (siteSwitch === null) problems.push("pageBar.when.siteSwitch must name one of this plugin's siteSwitches");
  let localAddresses: string | null = null;
  if (when.localAddresses !== undefined) {
    if (typeof when.localAddresses === "string" && rows.some((r) => r.key === when.localAddresses && r.type === "toggle")) localAddresses = when.localAddresses;
    else problems.push("pageBar.when.localAddresses must name one of this plugin's toggle rows");
  }
  const buttons = buttonsOf(problems, value.buttons);
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
