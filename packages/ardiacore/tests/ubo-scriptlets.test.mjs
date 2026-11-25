import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const UBO_SH = new URL("../scripts/ubo.sh", import.meta.url);
const VENDOR_EXT = new URL("../vendor/ubo/ext/", import.meta.url);
const bundled = { skip: existsSync(VENDOR_EXT) ? false : "needs the uBlock Origin build from scripts/ubo.sh" };

function applyUboPatches(files) {
  const script = readFileSync(UBO_SH, "utf8");
  const start = script.indexOf("def patch(rel, old, new):");
  const end = script.indexOf("\nPY\n", start);
  const patchBody = script.slice(start, end);
  const dir = mkdtempSync(join(tmpdir(), "ardia-ubo-test-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    const wanted = Object.keys(files);
    const runner = [
      "import os, sys",
      `ext, wanted = sys.argv[1], set(${JSON.stringify(wanted)})`,
      "def patch(rel, old, new):",
      "    if rel not in wanted: return",
      "    path = os.path.join(ext, rel)",
      "    source = open(path).read()",
      "    if source.count(old) != 1: sys.exit(f'mismatch in {rel}: {old.splitlines()[0]!r}')",
      "    open(path, 'w').write(source.replace(old, new))",
      patchBody.slice(patchBody.indexOf("\npatch(") + 1),
    ].join("\n");
    const res = spawnSync("python3", ["-I", "-c", runner, dir], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return Object.fromEntries(wanted.map((rel) => [rel, readFileSync(join(dir, rel), "utf8")]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const stripExports = (source) =>
  source
    .replace(/^import\s+[\s\S]*?;\s*$/gm, "")
    .replace(/\bexport\s+(?=(?:async\s+)?function\b)/g, "")
    .replace(/\bregisterScriptlet\s*\([\s\S]*?\);\s*/g, "");

function makeSandbox(href = "https://x.com/home") {
  const url = new URL(href);
  const ctx = vm.createContext({ URL, console, structuredClone, document: { location: { origin: url.origin, href: url.href } } });
  vm.runInContext("var self = globalThis; var window = globalThis;", ctx);
  return ctx;
}

const run = (code, ctx) => vm.runInContext(code, ctx, { timeout: 5000 });

const PROXY_APPLY_FIXTURE = `export function proxyToStringFn(proxiedFn, nativeFn) {
    if ( proxyToStringFn.proxies === undefined ) {
        proxyToStringFn.proxies = new WeakMap();
        proxyToStringFn.nativeToString = Function.prototype.toString;
        const proxiedToString = new Proxy(Function.prototype.toString, {
            apply(target, thisArg) {
                let proxied = thisArg;
                for(;;) { const fn = proxyToStringFn.proxies.get(proxied); if ( fn === undefined ) { break; } proxied = fn; }
                return proxyToStringFn.nativeToString.call(proxied);
            }
        });
        proxyToStringFn.proxies.set(proxiedToString, proxyToStringFn.nativeToString);
        Function.prototype.toString = proxiedToString;
    }
    proxyToStringFn.proxies.set(proxiedFn, nativeFn);
}
export function proxyApplyFn(target = '', handler = '', options = {}) {
    let context = globalThis, prop = target;
    for ( let pos; (pos = prop.indexOf('.')) !== -1; prop = prop.slice(pos + 1) ) { context = context[prop.slice(0, pos)]; }
    const fn = context[prop];
    if ( proxyApplyFn.CtorContext === undefined ) {
        proxyApplyFn.CtorContext = { factory: (c, a) => ({ reflect: () => Reflect.construct(c, a) }) };
        proxyApplyFn.ApplyContext = { factory: (c, t, a) => ({ reflect: () => Reflect.apply(c, t, a) }) };
        proxyApplyFn.isCtor = new Map();
        proxyApplyFn.proxies = new WeakMap();
        if ( (options.skipToString || proxyApplyFn.skipToString) !== true ) {
            proxyApplyFn.nativeToString = Function.prototype.toString;
            const proxiedToString = new Proxy(Function.prototype.toString, {
                apply(target, thisArg) {
                    let proxied = thisArg;
                    for(;;) { const fn = proxyApplyFn.proxies.get(proxied); if ( fn === undefined ) { break; } proxied = fn; }
                    return proxyApplyFn.nativeToString.call(proxied);
                }
            });
            proxyApplyFn.proxies.set(proxiedToString, proxyApplyFn.nativeToString);
            Function.prototype.toString = proxiedToString;
        }
    }
    const proxyDetails = {
        apply(target, thisArg, args) {
            return handler(proxyApplyFn.ApplyContext.factory(target, thisArg, args));
        }
    };
    const proxiedTarget = new Proxy(fn, proxyDetails);
    proxyApplyFn.proxies.set(proxiedTarget, fn);
    context[prop] = proxiedTarget;
}
`;

const PROBES = `function attempt(fn) {
  try { return fn(); } catch (e) { return e.constructor.name + ': ' + e.message; }
}
function probe(fn) {
  const before = Object.getPrototypeOf(fn);
  const out = {
    self: attempt(() => Object.setPrototypeOf(fn, fn) && 'set'),
    child: attempt(() => Object.setPrototypeOf(fn, Object.create(fn)) && 'set'),
    intact: Object.getPrototypeOf(fn) === before,
    toString: attempt(() => Function.prototype.toString.call(function sample() {})),
  };
  const loop = new Proxy({}, { getPrototypeOf: () => loop });
  out.loopingProto = attempt(() => Reflect.setPrototypeOf(fn, loop));
  out.throwingProto = attempt(() => Reflect.setPrototypeOf(fn, new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } })));
  let deep = fn;
  for (let i = 0; i < 5000; i++) deep = Object.create(deep);
  out.deepChain = attempt(() => Object.setPrototypeOf(fn, deep) && 'set');
  out.deepIntact = Object.getPrototypeOf(fn) !== deep;
  Object.setPrototypeOf(fn, before);
  return out;
}`;

const GUARDED = {
  self: "TypeError: Cyclic __proto__ value",
  child: "TypeError: Cyclic __proto__ value",
  intact: true,
  toString: "function sample() {}",
  loopingProto: "TypeError: Cyclic __proto__ value",
  throwingProto: true,
  deepChain: "TypeError: Cyclic __proto__ value",
  deepIntact: true,
};

function assertProxyGuard(proxyApplySource) {
  const code = stripExports(proxyApplySource);
  const applied = makeSandbox();
  run(
    `${code}\n${PROBES}
    globalThis.XMLHttpRequest = function XMLHttpRequest() {};
    globalThis.XMLHttpRequest.prototype.send = function send(v) { return v; };
    const nativeSend = globalThis.XMLHttpRequest.prototype.send;
    proxyApplyFn('XMLHttpRequest.prototype.send', (c) => c.reflect());
    proxyApplyFn('XMLHttpRequest.prototype.send', (c) => c.reflect());
    globalThis.__r = {
      toString: probe(Function.prototype.toString),
      send: probe(globalThis.XMLHttpRequest.prototype.send),
      sendDisguised: Function.prototype.toString.call(globalThis.XMLHttpRequest.prototype.send) === Function.prototype.toString.call(nativeSend),
      sendWorks: new globalThis.XMLHttpRequest().send('ok'),
    };`,
    applied,
  );
  assert.deepEqual({ ...applied.__r.toString }, GUARDED);
  assert.deepEqual({ ...applied.__r.send }, GUARDED);
  assert.equal(applied.__r.sendDisguised, true);
  assert.equal(applied.__r.sendWorks, "ok");

  const disguised = makeSandbox();
  run(
    `${code}\n${PROBES}
    function nativeFn() {}
    function wrappedFn() {}
    proxyToStringFn(wrappedFn, nativeFn);
    globalThis.__r = { toString: probe(Function.prototype.toString), wrapped: Function.prototype.toString.call(wrappedFn) };`,
    disguised,
  );
  assert.deepEqual({ ...disguised.__r.toString }, GUARDED);
  assert.equal(disguised.__r.wrapped, "function nativeFn() {}");
}

test("the patched proxy wrappers refuse prototype cycles like native functions and never hang", () => {
  const patched = applyUboPatches({ "js/resources/proxy-apply.js": PROXY_APPLY_FIXTURE });
  assertProxyGuard(patched["js/resources/proxy-apply.js"]);
});

test("the bundled proxy wrappers refuse prototype cycles like native functions and never hang", bundled, () => {
  assertProxyGuard(readFileSync(new URL("js/resources/proxy-apply.js", VENDOR_EXT), "utf8"));
});

async function compileScriptlets(scriptlets, rules, href) {
  const makeScriptlets = await import(new URL("js/make-scriptlets.js", VENDOR_EXT).href);
  makeScriptlets.resetAll();
  makeScriptlets.init(scriptlets);
  makeScriptlets.reset();
  for (const [args, matches] of rules) makeScriptlets.compile("uBlock", { args: [...args], matches, trustedSource: true });
  const readExt = (rel) => readFileSync(new URL(rel, VENDOR_EXT), "utf8");
  const core = makeScriptlets.commit("uBlock", readExt("js/scriptlet.template.js"), "test-secret");
  const framework = makeScriptlets.commitFramework(readExt("js/scriptlet-begin.template.js"), readExt("js/scriptlet-end.template.js"), "test-secret");
  return { code: `${framework.MAIN.beginCode}\n${core.MAIN.code}\n${framework.MAIN.endCode}`, ctx: makeSandbox(href) };
}

test("the bundled scriptlets run a higher priority first and keep uBlock Origin's order among equals", bundled, async () => {
  const mark = (name, priority) => ({
    name: `${name}.js`,
    priority,
    fn: new Function(`return function ${name.replace(/-/g, "_")}(tag) { (globalThis.__order ||= []).push(tag); }`)(),
  });
  const { code, ctx } = await compileScriptlets(
    [mark("mark-entity", 0), mark("mark-hostname", 0), mark("mark-first", 100)],
    [
      [["mark-entity", "self.$scriptletArglistPriorities$"], ["example.*"]],
      [["mark-hostname", "hostname"], ["sub.example.com"]],
      [["mark-first", "first"], ["example.com"]],
    ],
    "https://sub.example.com/",
  );
  run(code, ctx);
  assert.deepEqual([...ctx.__order], ["first", "hostname", "self.$scriptletArglistPriorities$"]);
});

test("the bundled x.com rules leave toString alone and keep the XHR wrapper safe from cycles", bundled, async () => {
  const { builtinScriptlets } = await import(new URL("js/resources/scriptlets.js", VENDOR_EXT).href);
  const xRules = readFileSync(new URL("assets/ublock/privacy.min.txt", VENDOR_EXT), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("x.com##+js("))
    .map((line) => {
      const inner = line.slice("x.com##+js(".length, -1);
      const comma = inner.indexOf(", ");
      return [comma === -1 ? [inner] : [inner.slice(0, comma), inner.slice(comma + 2)], ["x.com"]];
    });
  const names = xRules.map(([args]) => args[0]);
  assert.ok(names.indexOf("prevent-xhr") < names.indexOf("proxy-apply-config"), names.join());
  const { code, ctx } = await compileScriptlets(builtinScriptlets, xRules, "https://x.com/home");
  Object.assign(ctx, { fetch: () => {} });
  run(
    `${PROBES}
    globalThis.EventTarget = function EventTarget() {};
    globalThis.EventTarget.prototype.addEventListener = function addEventListener() {};
    globalThis.EventTarget.prototype.removeEventListener = function removeEventListener() {};
    globalThis.Request = function Request() {};
    globalThis.Request.prototype.clone = function clone() {};
    globalThis.XMLHttpRequest = function XMLHttpRequest() {};
    for (const m of ['open', 'send', 'getResponseHeader', 'getAllResponseHeaders']) globalThis.XMLHttpRequest.prototype[m] = function () {};
    globalThis.__native = { toString: Function.prototype.toString, send: globalThis.XMLHttpRequest.prototype.send };`,
    ctx,
  );
  run(code, ctx);
  run(
    `globalThis.__r = {
      toStringUntouched: Function.prototype.toString === __native.toString,
      sendWrapped: globalThis.XMLHttpRequest.prototype.send !== __native.send,
    };
    globalThis.__send = attempt(() => probe(globalThis.XMLHttpRequest.prototype.send));`,
    ctx,
  );
  assert.deepEqual({ ...ctx.__r }, { toStringUntouched: true, sendWrapped: true });
  assert.deepEqual({ ...ctx.__send }, GUARDED);
});
