export const row = (id, extra = {}) => ({ id, name: id, version: "1.0", description: "", enabled: true, state: "ENABLED", icon: "", permissions: [], siteAccess: null, sites: [], optionsUrl: null, pinned: false, incognito: false, fileAccess: false, mayModify: true, errors: [], ...extra });

export function extensionWorld() {
  const list = [];
  const folders = new Map();
  const installs = [];
  const gates = { inspect: null, install: null, list: null, reject: null, listFails: false, breakListsOnWrite: false };
  const reloads = [];
  const writes = [];
  const listCalls = { count: 0 };
  const uninstalls = [];
  const pkg = { version: "1.0", description: "", manifestVersion: 3, icon: null, permissions: [], optionalPermissions: [], hostPermissions: [], hasAction: false, popup: null, optionsPage: null, sidePanel: null };
  const engine = {
    list: async () => {
      listCalls.count++;
      const snapshot = list.map((x) => ({ ...x }));
      if (gates.list) await gates.list;
      if (gates.listFails) throw new Error("Chromium didn't answer");
      return snapshot;
    },
    install: async (path) => {
      const folder = folders.get(path);
      if (!folder) throw new Error("Manifest file is missing or unreadable");
      if (gates.install) await gates.install;
      if (gates.reject) throw new Error(gates.reject);
      const existing = list.find((x) => x.id === folder.id);
      const fields = { version: folder.version ?? "1.0", path };
      if (existing) Object.assign(existing, fields);
      else list.push(row(folder.id, fields));
      installs.push({ path, id: folder.id, version: fields.version });
      return folder.id;
    },
    reload: async (id) => void reloads.push(id),
    uninstall: async (id) => {
      uninstalls.push(id);
      list.splice(list.findIndex((x) => x.id === id), 1);
    },
    configure: async (id, _profile, options) => {
      const x = list.find((e) => e.id === id);
      if (gates.breakListsOnWrite) gates.listFails = true;
      writes.push({ id, ...options });
      if (options.incognito !== undefined && !x.ignoreIncognito) x.incognito = options.incognito;
      if (options.userScripts !== undefined) x.userScripts = options.userScripts;
      writes.at(-1).listCallsBefore = listCalls.count;
      if (x.vanishOnWrite) list.splice(list.indexOf(x), 1);
      if (options.siteAccess) {
        if (x.lockedSites) throw new Error("Can't change this extension's site access");
        if (options.siteAccess === "onClick") x.sites = [];
        if (options.siteAccess === "specificSites") x.sites = x.sites.filter((host) => !/^(<all_urls>|[^:]+:\/\/\*\/)/.test(host) && !x.revokeAllOnWithhold);
        x.siteAccess = options.siteAccess === "allSites" ? "ON_ALL_SITES" : x.sites.length && options.siteAccess === "specificSites" ? "ON_SPECIFIC_SITES" : "ON_CLICK";
      }
    },
    inspect: async (path) => {
      if (gates.inspect) await gates.inspect;
      const folder = folders.get(path);
      if (!folder) throw new Error("Manifest file is missing or unreadable");
      return { ...pkg, name: folder.id, version: folder.version ?? "1.0", path };
    },
  };
  globalThis.acTestUserScripts = { ...(globalThis.acTestUserScripts ?? {}), engine };
  return { list, folders, installs, gates, reloads, uninstalls, writes, listCalls };
}

export function gate() {
  let open;
  const shut = new Promise((resolve) => (open = resolve));
  return { shut, open: () => open() };
}
