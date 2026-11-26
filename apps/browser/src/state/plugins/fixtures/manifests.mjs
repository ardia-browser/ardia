const MOVED = ["commands", "tools", "hooks", "settings", "programs", "passwordManager"];

export function v3(doc, scope = "test") {
  const { manifest: _manifest, name, title, requires, alwaysOn: _alwaysOn, official: _official, autoInstall: _autoInstall, page, process, permissions, ...rest } = doc;
  const contributes = { ...(rest.contributes ?? {}) };
  for (const key of MOVED) {
    if (rest[key] === undefined) continue;
    contributes[key] = rest[key];
    delete rest[key];
  }
  if (page) contributes.panels = [...(contributes.panels ?? []), { id: "default", mode: "tab", ...page }];
  const out = {
    manifest: 3,
    ...rest,
    id: `@${scope}/${name}`,
    name: title ?? name,
    description: rest.description || `${title ?? name} for tests`,
    version: rest.version ?? "1.0.0",
    engines: { ardia: requires ? `>=${requires}` : ">=0.0.0" },
  };
  delete out.contributes;
  if (Object.keys(contributes).length) out.contributes = contributes;
  if (permissions !== undefined) out.permissions = Array.isArray(permissions) ? Object.fromEntries(permissions.map((p) => (p === "tabs" ? ["tabs", "read"] : p === "network" ? ["network", "*"] : [p, true]))) : permissions;
  if (out.permissions?.state?.events?.includes("downloads") && !out.permissions.downloads) out.permissions = { ...out.permissions, downloads: "read" };
  if (process !== undefined) out.sidecar = process;
  if ((contributes.programs?.length ?? 0) > 0 || out.permissions?.control === true) out.scope = "global";
  return out;
}

export const v3Text = (doc, scope) => JSON.stringify(v3(doc, scope));
