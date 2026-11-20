import { canonical, type Adapter } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { DEFAULT_SPACE_ID } from "../settings/settings";
import { sanitizeTheme } from "../../lib/profileLook";
import type { Space, ProfileTheme } from "../browser/types";
import { PROFILE, PROFILE_THEME, profileRecord } from "./records";

const store = () => useBrowser.getState();

export type SpaceRecord = { n: string; c: Space["color"]; i: string | null; d?: true; p?: string; pos?: string; th?: ProfileTheme | null };

export type SpaceThemeRecord = { t: ProfileTheme } | { preset: true };

export type ThemeAngleRecord = { a?: number; d?: number };

export const themeAngleKey = (syncId: string) => `${PROFILE_THEME}${syncId}:angle`;

function withoutAngles({ angle: _angle, dark, ...theme }: ProfileTheme): ProfileTheme {
  if (!dark) return theme;
  const { angle: _darkAngle, ...darkLook } = dark;
  return { ...theme, dark: darkLook };
}

function anglesOf(theme: ProfileTheme): ThemeAngleRecord {
  return { ...(theme.angle !== undefined ? { a: theme.angle } : {}), ...(theme.dark?.angle !== undefined ? { d: theme.dark.angle } : {}) };
}

export function themeFromRecord(record: unknown, angles?: unknown): Pick<Space, "theme"> | null {
  if (!record || typeof record !== "object") return null;
  if ("preset" in record && record.preset === true) return { theme: null };
  const theme = "t" in record ? sanitizeTheme(record.t) : null;
  if (!theme) return null;
  if (!angles || typeof angles !== "object") return { theme };
  const { a, d } = angles as Record<string, unknown>;
  const look = withoutAngles(theme);
  return { theme: sanitizeTheme({ ...look, angle: a, ...(look.dark ? { dark: { ...look.dark, angle: d } } : {}) }) };
}

export function legacyThemeOf(record: SpaceRecord): Pick<Space, "theme"> | null {
  const theme = record.th ? sanitizeTheme(record.th) : null;
  return theme ? { theme } : null;
}

export function spacesAdapter(
  links: () => Record<string, { syncId: string; ownerSyncId?: string; adopting?: true; keepPairingColor?: true }>,
  canPublish: (spaceId: string) => boolean = () => true,
): Adapter {
  const linked = () => Object.entries(links()).filter(([id]) => store().spaces[id]);
  return {
    prefix: PROFILE,
    adoptRemoteOnJoin: true,
    publishAfterPull: true,
    extract: (_base, _queued, _now, known, remote) => {
      const values = new Map<string, unknown>();
      for (const [id, { syncId, ownerSyncId, adopting }] of linked()) {
        if (!ownerSyncId || adopting || !canPublish(id)) continue;
        if (ownerSyncId !== syncId && !profileRecord(remote(`prof:${ownerSyncId}`))) continue;
        if (ownerSyncId !== syncId && !known(`share:${syncId}`)) continue;
        const p = store().spaces[id]!;
        values.set(`prof:${syncId}`, { n: p.name, c: p.color, i: p.icon, ...(id === DEFAULT_SPACE_ID ? { d: true } : {}) } satisfies SpaceRecord);
      }
      return { values, ignore: (key) => !values.has(key) };
    },
    apply: (visible, changed, _base, records) => {
      for (const [id, link] of linked()) {
        const { syncId } = link;
        const key = `prof:${syncId}`;
        const record = profileRecord(visible.get(key));
        if (!record || !changed.has(key)) continue;
        const legacy = store().spaces[id]!.theme === undefined && !records.known(`pth:${syncId}`) ? legacyThemeOf(record) : null;
        store().updateSpace(id, { name: record.n, ...(link.keepPairingColor ? {} : { color: record.c }), icon: record.i, ...legacy });
        delete link.adopting;
        delete link.keepPairingColor;
      }
      return true;
    },
  };
}

export function spaceThemesAdapter(
  links: () => Record<string, { syncId: string; themeAdopting?: true }>,
  records: () => Record<string, { v: unknown }> | undefined,
): Adapter {
  const linked = () => Object.entries(links()).filter(([id]) => store().spaces[id]);
  const unapplied = (key: string, base: (key: string) => unknown) => {
    const record = records()?.[key];
    return !!record && record.v !== null && canonical(record.v) !== canonical(base(key) ?? null);
  };
  return {
    prefix: PROFILE_THEME,
    adoptRemoteOnJoin: true,
    extract: (base, _queued, _now, known) => {
      const values = new Map<string, unknown>();
      for (const [id, { syncId, themeAdopting }] of linked()) {
        const theme = store().spaces[id]!.theme;
        const key = `pth:${syncId}`;
        const angleKey = themeAngleKey(syncId);
        if (theme === undefined || themeAdopting || unapplied(key, base) || unapplied(angleKey, base)) continue;
        values.set(key, (theme ? { t: withoutAngles(theme) } : { preset: true }) satisfies SpaceThemeRecord);
        const angles = theme ? anglesOf(theme) : {};
        if (Object.keys(angles).length || known(angleKey)) values.set(angleKey, angles satisfies ThemeAngleRecord);
      }
      const mine = new Set(values.keys());
      return { values, ignore: (key) => !mine.has(key) };
    },
    apply: (visible, changed) => {
      for (const [id, { syncId }] of linked()) {
        const angleKey = themeAngleKey(syncId);
        if (!changed.has(`${PROFILE_THEME}${syncId}`) && !changed.has(angleKey)) continue;
        const patch = themeFromRecord(visible.get(`${PROFILE_THEME}${syncId}`), visible.get(angleKey));
        if (!patch) continue;
        store().updateSpace(id, patch);
      }
    },
  };
}
