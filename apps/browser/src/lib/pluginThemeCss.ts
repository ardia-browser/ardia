import { t } from "./uiLanguage";
export type PluginThemeRoles = { scheme: "light" | "dark"; roles: Readonly<Record<string, unknown>> };

const ROLE_NAME = /^[A-Za-z][A-Za-z0-9]{0,47}$/;
const SAFE_VALUE = /^[#A-Za-z0-9(),.%\s/+-]{1,96}$/;
const UNSAFE_WORDS = /(url|expression|image|var|attr|env)\s*\(/i;
const MAX_ROLES = 256;

export const cssRoleName = (role: string) => `--ardia-${role.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`).replace(/[^a-z0-9-]/g, "")}`;

export function cssRoleValue(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!SAFE_VALUE.test(text) || UNSAFE_WORDS.test(text)) return null;
  return text;
}

export function pluginThemeVariables(roles: Readonly<Record<string, unknown>>): [string, string][] {
  const out: [string, string][] = [];
  for (const [role, value] of Object.entries(roles)) {
    if (out.length >= MAX_ROLES) break;
    if (!ROLE_NAME.test(role)) continue;
    const css = cssRoleValue(value);
    if (css !== null) out.push([cssRoleName(role), css]);
  }
  return out;
}

const fallback = (role: string, system: string) => `var(${cssRoleName(role)}, ${system})`;

export function buildPluginThemeCss(theme: PluginThemeRoles): string {
  const scheme = theme.scheme === "dark" ? "dark" : "light";
  const variables = pluginThemeVariables(theme.roles).map(([name, value]) => `  ${name}: ${value};`);
  return [
    t(`:root {`),
    `  color-scheme: ${scheme};`,
    ...variables,
    "}",
    t(`*, *::before, *::after { box-sizing: border-box; }`),
    `html, body { margin: 0; padding: 0; background: ${fallback("background", "Canvas")}; color: ${fallback("text", "CanvasText")}; }`,
    t(`body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }`),
    `a { color: ${fallback("accent", "LinkText")}; }`,
    `::selection { background: ${fallback("selection", "Highlight")}; }`,
    "",
  ].join("\n");
}
