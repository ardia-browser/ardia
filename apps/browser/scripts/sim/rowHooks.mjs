import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { hookRunner } from "./hookRunner.mjs";

export const PER_ROW_FILES = [
  "components/sidebar/TabRow.tsx",
  "components/sidebar/TabPressArea.tsx",
  "components/sidebar/TabIcon.tsx",
  "components/sidebar/TileFace.tsx",
  "components/sidebar/TileStatus.tsx",
  "components/sidebar/RowCloseButton.tsx",
  "components/sidebar/RowHoverParts.tsx",
  "components/sidebar/SidebarRow.tsx",
  "components/sidebar/AwayTitle.tsx",
  "components/sidebar/FolderTile.tsx",
  "components/sidebar/hoverController.ts",
  "components/tabstrip/TabChip.tsx",
  "components/tabstrip/PinnedFace.tsx",
  "components/tabstrip/SplitChip.tsx",
  "components/tabstrip/GroupMember.tsx",
  "components/media/TabBadges.tsx",
  "components/media/HoverPlayer.tsx",
];

function perRowHookImports(srcDir) {
  const found = new Map();
  for (const file of PER_ROW_FILES) {
    const path = `${srcDir}/${file}`;
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"((?:\.\.\/)+state\/[^"]+)"/g)) {
      const module = m[2].replace(/^(\.\.\/)+/, "");
      for (const raw of m[1].split(",")) {
        const name = raw.trim().replace(/^type\s+.*/, "").split(/\s+as\s+/)[0];
        if (!/^use[A-Z]/.test(name)) continue;
        const key = `${module}#${name}`;
        if (!found.has(key)) found.set(key, { module, name, usedBy: new Set() });
        found.get(key).usedBy.add(file);
      }
    }
  }
  return [...found.values()];
}

function paramNames(fn) {
  const text = Function.prototype.toString.call(fn);
  const open = text.indexOf("(");
  let depth = 0;
  let close = open;
  for (let i = open; i < text.length; i++) {
    if ("([{<".includes(text[i])) depth++;
    else if (")]}>".includes(text[i]) && !(text[i] === ">" && text[i - 1] === "=")) depth--;
    if (depth === 0) {
      close = i;
      break;
    }
  }
  const inside = text.slice(open + 1, close);
  const parts = [];
  let current = "";
  depth = 0;
  for (const ch of inside) {
    if ("([{<".includes(ch)) depth++;
    if (")]}>".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => (p.trim().match(/^[A-Za-z_$][\w$]*/) ?? [""])[0]);
}

function argumentFor(name, row) {
  const n = name.toLowerCase();
  if (n === "tabid" || n === "id" || n === "key") return row.tabId;
  if (n === "tabids" || n === "ids") return [row.tabId];
  if (n === "windowid") return row.windowId;
  if (n === "profileid") return row.profileId;
  if (n === "groupid" || n === "folderid") return row.groupId;
  if (n === "splitid") return row.splitId ?? "none";
  if (n === "url") return row.url;
  if (/^(live|enabled|active|shown|visible|on|open)$/.test(n)) return true;
  if (/^(select|selector|read|pick|equal)$/.test(n)) return n === "equal" ? undefined : (x) => x;
  return undefined;
}

export async function loadRowHooks(world) {
  const srcDir = fileURLToPath(world.modules.root);
  const require = createRequire(new URL("index.js", world.modules.root));
  const React = await import(require.resolve("react"));
  const runner = hookRunner(React.default ?? React);
  const contexts = await world.modules.optional("state/browser/hooks.ts");
  const hooks = [];
  for (const entry of perRowHookImports(srcDir)) {
    const mod = (await world.modules.optional(`${entry.module}.ts`)) ?? (await world.modules.optional(`${entry.module}.tsx`));
    const fn = mod?.[entry.name];
    hooks.push({ ...entry, usedBy: [...entry.usedBy].sort(), fn: typeof fn === "function" ? fn : null, params: typeof fn === "function" ? paramNames(fn) : [] });
  }
  return { runner, hooks, WindowContext: contexts?.WindowContext, PageProfileContext: contexts?.PageProfileContext };
}

export function rowsOf(world) {
  const s = world.S();
  const groupOf = (id) => Object.values(s.groups).find((g) => g.tabIds.includes(id))?.id ?? null;
  const splitOf = (id) => Object.values(s.splits ?? {}).find((v) => JSON.stringify(v.slots ?? []).includes(id))?.id;
  return Object.values(s.tabs)
    .filter((t) => s.windows[t.windowId])
    .map((t) => ({ tabId: t.id, windowId: t.windowId, profileId: t.profileId, groupId: groupOf(t.id), splitId: splitOf(t.id), url: t.url }));
}

export function mountRows(world, loaded, rows) {
  const instances = [];
  const failures = new Map();
  for (const hook of loaded.hooks) {
    if (!hook.fn) continue;
    for (const row of rows) {
      const args = hook.params.map((p) => argumentFor(p, row));
      const contexts = new Map();
      if (loaded.WindowContext) contexts.set(loaded.WindowContext, row.windowId);
      try {
        const instance = loaded.runner.mount(() => hook.fn(...args), { contexts, label: `${hook.module}#${hook.name}` });
        instances.push({ hook, row, instance });
      } catch (error) {
        failures.set(`${hook.module}#${hook.name}`, String(error?.message ?? error).split("\n")[0]);
      }
    }
  }
  return { instances, failures };
}
