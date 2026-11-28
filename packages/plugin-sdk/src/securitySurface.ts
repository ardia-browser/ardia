import { permissionGrants, type PermissionsV3 } from "./manifestPermissions";
import { hostCoveredBy, patternCovers } from "./matchPatterns";

type ScriptShape = { id?: string; matches?: readonly string[]; js?: readonly string[]; css?: readonly string[]; runAt?: string; allFrames?: boolean; when?: string };

type CommandShape = { name?: string; shortcut?: string; open?: string; tool?: string; handler?: boolean; view?: string; panel?: string; inputMode?: string };

export type SecuritySurfaceInput = {
  scope?: "global" | "profile";
  permissions?: PermissionsV3 | Readonly<Record<string, unknown>>;
  sidecar?: { run: readonly string[]; memoryMB?: number } | null;
  dependencies?: Readonly<Record<string, string>>;
  optionalDependencies?: Readonly<Record<string, string>>;
  consumes?: readonly string[];
  contributes?: {
    programs?: readonly { name: string; path?: string; afterUpdate?: readonly (readonly string[])[] }[];
    hooks?: readonly string[];
    passwordManager?: unknown;
    contentScripts?: readonly ScriptShape[];
    pageStyles?: readonly { id?: string; matches?: readonly string[]; css?: string; when?: string }[];
    netRules?: string;
    menus?: Readonly<Record<string, readonly { command: string; when?: string }[] | undefined>>;
    commands?: readonly CommandShape[];
    panels?: readonly { id?: string; mode?: string; view?: string; file?: string; side?: string; retainContext?: boolean }[];
  };
};

export type SecurityDiff = { expanded: boolean; added: string[]; removed: string[] };

type Grant = { key: string; covers?: (earlier: Grant) => boolean; data?: Record<string, unknown> };

const DEFAULT_SIDECAR_MB = 1024;
const RUN_AT_REACH: Record<string, number> = { document_idle: 0, document_start: 1 };

const plain = (key: string): Grant => ({ key });

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

function permissionGrant(key: string): Grant {
  const page = key.startsWith("pages:") ? key.slice(6) : null;
  if (page !== null) return { key, covers: (e) => e.key.startsWith("pages:") && patternCovers(e.key.slice(6), page) };
  const host = key.startsWith("network:") ? key.slice(8) : null;
  if (host !== null && host !== "*") return { key, covers: (e) => e.key === "network:*" || (e.key.startsWith("network:") && hostCoveredBy([e.key.slice(8)], host)) };
  return plain(key);
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

const coversAll = (outer: readonly string[], inner: readonly string[]) => inner.every((match) => outer.some((o) => patternCovers(o, match)));

type ScriptUnit = { kind: "script"; js: string[]; css: string[]; matches: string[]; reach: number; allFrames: boolean; when: string | undefined };

type StyleUnit = { kind: "style"; css: string; matches: string[]; when: string | undefined };

function scriptGrants(scripts: readonly ScriptShape[]): Grant[] {
  return scripts.map((script) => {
    const runAt = script.runAt ?? "document_idle";
    const unit: ScriptUnit = {
      kind: "script",
      js: list<string>(script.js),
      css: list<string>(script.css),
      matches: list<string>(script.matches),
      reach: RUN_AT_REACH[runAt] ?? 2,
      allFrames: script.allFrames === true,
      when: (script as { when?: string }).when,
    };
    return {
      key: `contentScripts:${JSON.stringify({ js: [...unit.js].sort(), css: [...unit.css].sort(), matches: [...unit.matches].sort(), runAt, allFrames: unit.allFrames, when: unit.when ?? null })}`,
      data: unit,
      covers: (e: Grant) => {
        const prior = e.data as ScriptUnit | undefined;
        return (
          prior?.kind === "script" &&
          sameList(prior.js, unit.js) &&
          sameList(prior.css, unit.css) &&
          prior.reach >= unit.reach &&
          (prior.allFrames || !unit.allFrames) &&
          (prior.when === undefined || prior.when === unit.when) &&
          coversAll(prior.matches, unit.matches)
        );
      },
    };
  });
}

function styleGrants(styles: NonNullable<SecuritySurfaceInput["contributes"]>["pageStyles"]): Grant[] {
  return list<{ matches?: readonly string[]; css?: string; when?: string }>(styles).map((style) => {
    const unit: StyleUnit = { kind: "style", css: style.css ?? "", matches: list<string>(style.matches), when: style.when };
    return {
      key: `pageStyles:${JSON.stringify({ css: unit.css, matches: [...unit.matches].sort(), when: unit.when ?? null })}`,
      data: unit,
      covers: (e: Grant) => {
        const prior = e.data as StyleUnit | undefined;
        return prior?.kind === "style" && prior.css === unit.css && (prior.when === undefined || prior.when === unit.when) && coversAll(prior.matches, unit.matches);
      },
    };
  });
}

function menuGrants(menus: NonNullable<SecuritySurfaceInput["contributes"]>["menus"]): Grant[] {
  const out: Grant[] = [];
  for (const [slot, items] of Object.entries(menus ?? {})) {
    for (const item of list<{ command: string; when?: string }>(items)) {
      const base = `menus:${slot}:${item.command}`;
      out.push({ key: item.when === undefined ? base : `${base}:when=${item.when}`, covers: (e) => e.key === base });
    }
  }
  return out;
}

const COMMAND_TARGET_KEYS = ["view", "panel", "tool", "open", "handler", "inputMode", "path", "side", "sideSetting", "context"] as const;

function commandGrants(commands: readonly CommandShape[]): Grant[] {
  return commands.flatMap((c) => {
    const record = c as Record<string, unknown>;
    const target = Object.fromEntries(COMMAND_TARGET_KEYS.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
    return [...(c.shortcut ? [plain(`commands.shortcut:${c.name}:${c.shortcut}`)] : []), plain(`commands.target:${c.name}:${JSON.stringify(target)}`)];
  });
}

function grantsOf(input: SecuritySurfaceInput | null | undefined): Grant[] {
  if (!input) return [];
  const c = input.contributes ?? {};
  const grants: Grant[] = permissionGrants(input.permissions as PermissionsV3 | undefined).map(permissionGrant);
  if (input.scope === "global") grants.push(plain("scope:global"));
  if (input.sidecar) {
    const memory = input.sidecar.memoryMB ?? DEFAULT_SIDECAR_MB;
    grants.push(plain("sidecar"), plain(`sidecar.run:${JSON.stringify(input.sidecar.run)}`));
    grants.push({ key: `sidecar.memoryMB:${memory}`, data: { memory }, covers: (e) => e.key.startsWith("sidecar.memoryMB:") && (e.data?.memory as number) >= memory });
  }
  for (const [id, range] of Object.entries(input.dependencies ?? {})) grants.push(plain(`dependencies:${id}@${range}`));
  for (const [id, range] of Object.entries(input.optionalDependencies ?? {})) grants.push(plain(`optionalDependencies:${id}@${range}`));
  for (const iface of list<string>(input.consumes)) grants.push(plain(`consumes:${iface}`));
  for (const program of list<{ name: string; path?: string; afterUpdate?: unknown }>(c.programs)) {
    grants.push(plain(`programs:${program.name}`), plain(`programs:${program.name}:${JSON.stringify([program.path ?? null, program.afterUpdate ?? []])}`));
  }
  for (const hook of list<string>(c.hooks)) grants.push(plain(`hooks:${hook}`));
  if (c.passwordManager) grants.push(plain("passwordManager"));
  if (c.netRules) grants.push(plain(`netRules:${c.netRules}`));
  for (const panel of list<Record<string, unknown>>(c.panels)) {
    const target = Object.fromEntries(["mode", "view", "file", "side", "retainContext"].filter((key) => panel[key] !== undefined).map((key) => [key, panel[key]]));
    grants.push(plain(`panels:${String(panel.id)}:${JSON.stringify(target)}`));
  }
  grants.push(...scriptGrants(list<ScriptShape>(c.contentScripts)), ...styleGrants(c.pageStyles), ...menuGrants(c.menus), ...commandGrants(list<CommandShape>(c.commands)));
  const unique = new Map<string, Grant>();
  for (const grant of grants) if (!unique.has(grant.key)) unique.set(grant.key, grant);
  return [...unique.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export const securitySurface = (input: SecuritySurfaceInput | null | undefined): string[] => grantsOf(input).map((g) => g.key);

export function diffSecuritySurface(previous: SecuritySurfaceInput | null | undefined, next: SecuritySurfaceInput | null | undefined): SecurityDiff {
  const before = grantsOf(previous);
  const after = grantsOf(next);
  const beforeKeys = new Set(before.map((g) => g.key));
  const afterKeys = new Set(after.map((g) => g.key));
  const added = after.filter((g) => !beforeKeys.has(g.key) && !before.some((e) => g.covers?.(e) === true)).map((g) => g.key);
  const removed = before.filter((g) => !afterKeys.has(g.key)).map((g) => g.key);
  return { expanded: added.length > 0, added, removed };
}
