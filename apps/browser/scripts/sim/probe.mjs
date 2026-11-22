import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INTERNAL = /\/(state\/browser\/(store|transaction|keyedWatch)\.ts|state\/tabs\/tabWatch\.ts|scripts\/sim\/|node_modules\/)/;

export function siteOf(stack, srcDir) {
  for (const line of String(stack).split("\n").slice(1)) {
    const m = line.match(/at (?:(.+?) \()?(?:file:\/\/)?([^():]+):\d+:\d+\)?$/);
    if (!m) continue;
    const [, fn, file] = m;
    if (INTERNAL.test(file) || !file.startsWith(srcDir)) continue;
    const name = (fn ?? "").replace(/ \[as \w+\]$/, "").replace(/^(Object|Module)\./, "");
    return `${file.slice(srcDir.length)}${name && !name.startsWith("file") ? `#${name}` : ""}`;
  }
  return "(outside src)";
}

export function instrumentStore(world, { trackReads = false, keepUnsubscribed = true } = {}) {
  Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 60);
  const { useBrowser } = world.modules.store;
  const srcDir = fileURLToPath(world.modules.root);
  const registry = [];
  const plainSubscribe = useBrowser.subscribe;
  const probe = { registry, kind: "boot", rowMount: null, steps: {}, wholeStoreSubscribe: plainSubscribe };
  const keyedSubscribe = useBrowser.subscribeTo;
  const realGetState = useBrowser.getState;
  const proxies = new WeakMap();
  const reading = (s, reads) => {
    if (!s || typeof s !== "object") return s;
    let byReads = proxies.get(s);
    if (!byReads) proxies.set(s, (byReads = new Map()));
    if (!byReads.has(reads))
      byReads.set(
        reads,
        new Proxy(s, {
          get(target, key, receiver) {
            if (typeof key === "string" && Object.prototype.hasOwnProperty.call(target, key)) reads.add(key);
            return Reflect.get(target, key, receiver);
          },
        }),
      );
    return byReads.get(reads);
  };
  const wrappers = new WeakMap();
  const register = (via, keys, listener, stack) => {
    const cacheKey = `${via}|${keys ? keys.join(",") : ""}`;
    const cached = wrappers.get(listener)?.get(cacheKey);
    if (cached) return cached;
    const entry = { via, keys, site: siteOf(stack, srcDir), rowHook: probe.rowMount, alive: true, calls: {}, reads: new Set() };
    registry.push(entry);
    const wrapped = (s, prev) => {
      entry.calls[probe.kind] = (entry.calls[probe.kind] ?? 0) + 1;
      if (!trackReads) return listener(s, prev);
      const reads = entry.reads;
      const outer = useBrowser.getState;
      if (via !== "keyed watch") useBrowser.getState = () => reading(realGetState(), reads);
      try {
        return listener(reading(s, reads), reading(prev, reads));
      } finally {
        useBrowser.getState = outer;
      }
    };
    const made = { entry, wrapped };
    entry.listener = listener;
    if (!wrappers.has(listener)) wrappers.set(listener, new Map());
    wrappers.get(listener).set(cacheKey, made);
    return made;
  };
  const unsubscribing = (entry, off) => () => {
    entry.alive = false;
    if (!keepUnsubscribed) {
      const at = registry.indexOf(entry);
      if (at !== -1) registry.splice(at, 1);
      wrappers.get(entry.listener)?.clear();

    }
    off();
  };
  const plain = (via) => (listener) => {
    const { entry, wrapped } = register(via, null, listener, new Error().stack);
    return unsubscribing(entry, plainSubscribe(wrapped));
  };
  useBrowser.subscribe = Object.assign(plain("subscribe"), { unprobed: plain("keyed watch") });
  if (keyedSubscribe)
    useBrowser.subscribeTo = (keys, listener) => {
      const { entry, wrapped } = register("subscribeTo", [...keys], listener, new Error().stack);
      return unsubscribing(entry, keyedSubscribe(keys, wrapped));
    };
  probe.alive = () => registry.filter((e) => e.alive).length;
  probe.during = async (kind, run) => {
    const held = probe.kind;
    probe.kind = kind;
    try {
      return await run();
    } finally {
      probe.kind = held;
    }
  };
  return probe;
}

export function serviceStarts(srcDir) {
  let main;
  try {
    main = readFileSync(`${srcDir}/main.tsx`, "utf8");
  } catch {
    return [];
  }
  const from = new Map();
  for (const m of main.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/(state\/[^"]+)"/g)) for (const name of m[1].split(",").map((n) => n.trim())) if (/^start[A-Z]/.test(name)) from.set(name, m[2]);
  const order = [];
  for (const m of main.matchAll(/^(?:afterFirstWindow\()?(start[A-Z]\w*)[(),]/gm)) if (from.has(m[1]) && m[1] !== "startPersistence" && !order.includes(m[1])) order.push(m[1]);
  return order.map((name) => ({ name, module: from.get(name) }));
}

export async function startServices(world) {
  const srcDir = fileURLToPath(world.modules.root);
  const started = [];
  const failed = [];
  const tokens = await world.modules.optional("components/ui/tokens.ts");
  for (const { name, module } of serviceStarts(srcDir)) {
    try {
      const mod = (await world.modules.optional(`${module}.ts`)) ?? (await world.modules.optional(`${module}.tsx`)) ?? (await world.modules.optional(`${module}/index.ts`));
      if (typeof mod?.[name] !== "function") throw new Error("not found");
      await mod[name](name === "startConfigFiles" ? tokens?.colorRoles : undefined);
      started.push(name);
    } catch (error) {
      failed.push(`${name}: ${String(error?.message ?? error).split("\n")[0].slice(0, 80)}`);
    }
  }
  return { started, failed };
}
