import { createContext, useContext, useMemo, type ReactNode } from "react";
import { backdropIsDark, liftedInk, READABLE_GLYPH, READABLE_TEXT } from "../../lib/readableInk";
import { rolesFor, useTheme, type Theme } from "./theme";
import { chromeInk, tabsInk, type ColorRoles } from "./tokens";

type ChromeInk = { [Role in keyof (typeof chromeInk)["light"]]: string };

export type SurfaceInk = { dark: boolean; roles: ColorRoles; chrome: ChromeInk };

const TEXT_ROLES = ["label", "headerText", "foregroundPrimary", "toastLabel", "toastDetail"] as const;

const QUIET_ROLES = ["secondaryLabel", "foregroundSecondary", "rowIcon"] as const;

const plateRoles = (base: ColorRoles, dark: boolean): ColorRoles => {
  const roles: Record<string, unknown> = { ...base, dark };
  for (const role of TEXT_ROLES) roles[role] = liftedInk(base[role], dark, READABLE_TEXT);
  for (const role of QUIET_ROLES) roles[role] = liftedInk(base[role], dark, READABLE_GLYPH);
  return roles as ColorRoles;
};

const plateChrome = (dark: boolean): ChromeInk => {
  const chrome = dark ? chromeInk.dark : chromeInk.light;
  return { ...chrome, foreground: liftedInk(chrome.foreground, dark, READABLE_TEXT), secondary: liftedInk(chrome.secondary, dark, READABLE_GLYPH) };
};

const surfaceInkCache = new Map<boolean, SurfaceInk>();

export function surfaceInkFor(dark: boolean, theme?: Theme): SurfaceInk {
  if (theme && theme.dark === dark) return { dark, roles: plateRoles(theme, dark), chrome: plateChrome(dark) };
  const known = surfaceInkCache.get(dark);
  if (known) return known;
  const made = { dark, roles: plateRoles(rolesFor(dark), dark), chrome: plateChrome(dark) };
  surfaceInkCache.set(dark, made);
  return made;
}

const SurfaceInkContext = createContext<SurfaceInk | null>(null);

export function SurfaceInkProvider({ dark, children }: { dark: boolean; children?: ReactNode }) {
  const theme = useTheme();
  const ink = useMemo(() => surfaceInkFor(dark, theme), [dark, theme]);
  return <SurfaceInkContext.Provider value={ink}>{children}</SurfaceInkContext.Provider>;
}

export function useSurfaceInk(): SurfaceInk {
  const surface = useContext(SurfaceInkContext);
  const theme = useTheme();
  return useMemo(() => surface ?? { dark: theme.dark, roles: theme, chrome: theme.dark ? chromeInk.dark : chromeInk.light }, [surface, theme]);
}

export const useOnPlate = () => useContext(SurfaceInkContext) !== null;

export function PlateInk({ children }: { children: (ink: SurfaceInk) => ReactNode }) {
  return <>{children(useSurfaceInk())}</>;
}

export type BackdropKind = "start" | "deck" | "canvas";

export const backdropColors = (theme: Pick<Theme, "start" | "backdrop" | "canvas">, kind: BackdropKind, incognito: boolean): readonly string[] =>
  incognito ? tabsInk.incognitoBackdrop : kind === "start" ? theme.start.colors : kind === "deck" ? theme.backdrop : [theme.canvas];

export const backdropShade = (theme: Pick<Theme, "start" | "backdrop" | "canvas">, kind: BackdropKind, incognito: boolean) => incognito || backdropIsDark(backdropColors(theme, kind, incognito));

export function useBackdropDark(kind: BackdropKind, incognito: boolean): boolean {
  const theme = useTheme();
  return useMemo(() => backdropShade(theme, kind, incognito), [theme, kind, incognito]);
}
