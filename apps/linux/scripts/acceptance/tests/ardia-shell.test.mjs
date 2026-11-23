import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { after, before, describe, it } from "node:test";
import { ArdiaApp, launchArdia, launchArguments, launchEnvironment } from "../lib/ardia.mjs";
import { connectCdp } from "../lib/cdp.mjs";
import { withSignal } from "../lib/util.mjs";
import { startMockCdp } from "./mock-cdp.mjs";

function fakeShell({ windowId, startup = false, utility = null }) {
  const commands = [];
  const state = {
    windows: { [windowId]: { id: windowId, profileId: "default", tabIds: ["t1"], activeTabIds: { default: "t1" } } },
    tabs: { t1: { id: "t1", windowId, url: "" } },
    find: {},
    newTab(owner, { url }) {
      const id = `t${Object.keys(state.tabs).length + 1}`;
      state.tabs[id] = { id, windowId: owner, url: "" };
      state.windows[owner].tabIds.push(id);
      setTimeout(() => { state.tabs[id].url = url; }, 30);
      return id;
    },
    navigate(id, url) { setTimeout(() => { state.tabs[id].url = url; }, 30); },
  };
  const host = {
    bootstrap: { windowId, profileId: "default", startup, utility },
    async invoke(method, args) {
      if (method === "ArdiaShell.windowIds") return ["main", "second"];
      if (method === "tab.create") throw Object.assign(new Error("Profile not hosted"), { code: "ERR_PROFILE_WINDOW" });
      return { method, args };
    },
    async call(name, profile, args) {
      return JSON.stringify({ name, profile, args: JSON.parse(args) });
    },
  };
  const context = vm.createContext({
    ardiaLinux: { store: { getState: () => state }, emitCommand: (event) => commands.push(event) },
    __ardiaHost: host,
    document: { querySelector: (selector) => (selector === "[data-ardia-linux-window]" ? {} : null), body: { innerText: `window ${windowId}` } },
    globalThis: undefined,
    JSON,
    Promise,
    setTimeout,
  });
  context.globalThis = context;
  return { context, commands, state };
}

async function evaluateIn(context, expression) {
  try {
    const value = await vm.runInContext(expression, context);
    return { result: { type: typeof value, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
  } catch (error) {
    return { exceptionDetails: { text: "Uncaught", exception: { description: String(error?.stack ?? error) } } };
  }
}

describe("Ardia launch plumbing and shell driver against a mock host", () => {
  let mock;
  let scratch;
  const shells = {
    main: fakeShell({ windowId: "main", startup: true }),
    second: fakeShell({ windowId: "second" }),
    settings: fakeShell({ windowId: "settings", utility: { pane: "general" } }),
  };
  let sleeper;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "ardia-acceptance-mock-"));
    mock = await startMockCdp({
      targets: [
        { id: "shell-second", type: "page", url: "chrome://ardia/index.html" },
        { id: "shell-main", type: "page", url: "chrome://ardia/index.html" },
        { id: "shell-settings", type: "page", url: "chrome://ardia/index.html" },
        { id: "page-1", type: "page", url: "http://plain.ardia.test/page/1" },
      ],
      handlers: {
        "Runtime.evaluate": (params, { targetId }) => {
          const shell = shells[targetId.replace("shell-", "")];
          return shell ? evaluateIn(shell.context, params.expression) : { result: { type: "undefined" } };
        },
        "Browser.close": () => { sleeper?.kill("SIGTERM"); return {}; },
      },
    });
  });
  after(async () => {
    await mock.close();
    await rm(scratch, { recursive: true, force: true });
  });

  const fakeSpawn = (writePort = true, exitAfter = writePort ? null : 100) => (executable, args, options) => {
    sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...options, env: process.env });
    if (writePort) void writeFile(join(scratch, "DevToolsActivePort"), `${mock.port}\n/devtools/browser/mock\n`);
    if (exitAfter !== null) { const child = sleeper; setTimeout(() => child.kill("SIGTERM"), exitAfter); }
    return sleeper;
  };

  it("builds headless, throwaway launch arguments and environment", () => {
    const args = launchArguments({ scratch: "/s", uiDir: "/ui", extraArgs: ["--x"] });
    for (const flag of ["--user-data-dir=/s", "--ozone-platform=headless", "--remote-debugging-port=0", "--ardia-ui-dir=/ui", "--x"]) assert.ok(args.includes(flag), flag);
    assert.ok(args.includes("--disable-extensions"));
    assert.ok(!launchArguments({ scratch: "/s", extensions: true }).includes("--disable-extensions"));
    const env = launchEnvironment({ scratch: "/s", base: { PATH: "/bin", ARDIA_SWITCHES: "a=1", XDG_ACTIVATION_TOKEN: "t", WAYLAND_DISPLAY: "wayland-1" } });
    assert.equal(env.ARDIA_BACKGROUND, "1");
    assert.equal(env.ARDIA_DATA_DIR, "/s");
    assert.equal(env.HOME, "/s/home");
    assert.equal(env.WAYLAND_DISPLAY, "");
    assert.ok(!("ARDIA_SWITCHES" in env) && !("XDG_ACTIVATION_TOKEN" in env));
    assert.match(env.DBUS_SESSION_BUS_ADDRESS, /^unix:path=\/s\//);
    const foreground = launchEnvironment({ scratch: "/s", background: false, base: { ARDIA_BACKGROUND: "1" } });
    assert.ok(!("ARDIA_BACKGROUND" in foreground));
  });

  it("launches, finds shells by bootstrap and prefers the startup window", async () => {
    const app = await launchArdia({ executable: "/bin/true", scratch, spawnImpl: fakeSpawn(), startTimeout: 5000 });
    try {
      const found = await app.shells();
      assert.deepEqual(found.map((s) => s.windowId).sort(), ["main", "second", "settings"]);
      const main = await app.mainShell({ timeout: 3000 });
      assert.equal(main.windowId, "main");
      const second = await app.shell("second", { timeout: 3000 });
      assert.equal(second.windowId, "second");
      assert.deepEqual(await main.windowIds(), ["main", "second"]);
      const id = await main.newTab("http://plain.ardia.test/page/2");
      const tab = await main.waitTabUrl(id, (url) => url === "http://plain.ardia.test/page/2", { timeout: 2000 });
      assert.equal(tab.windowId, "main");
      assert.equal(await main.activeTabId(), "t1");
      await main.command("findNext");
      assert.deepEqual(JSON.parse(JSON.stringify(shells.main.commands)), [{ command: "findNext", windowId: "main" }]);
      const refused = await main.invoke("tab.create", { profile: "default" });
      assert.deepEqual(refused, { ok: false, code: "ERR_PROFILE_WINDOW", message: "Profile not hosted" });
      const reply = await main.call("downloads.pause", { id: "x" });
      assert.deepEqual(reply, { ok: true, value: { name: "downloads.pause", profile: "", args: { id: "x" } } });
      assert.equal(await main.text(), "window main");
      const target = await app.pageTarget((t) => t.url.endsWith("/page/1"), { timeout: 1000 });
      assert.equal(target.id, "page-1");
    } finally {
      const pid = sleeper.pid;
      assert.equal(await app.close(), true);
      assert.throws(() => process.kill(-pid, 0));
      assert.ok(mock.received.some((m) => m.method === "Browser.close"));
    }
  });

  it("turns core dumps off through a shell wrapper only when asked", async () => {
    const seen = [];
    const recording = (executable, args, options) => {
      seen.push([executable, args]);
      return fakeSpawn(false)(executable, args, options);
    };
    await assert.rejects(launchArdia({ executable: "/opt/ardia/bin/ardia", scratch, spawnImpl: recording, coreDumps: false, startTimeout: 10000 }), /exited/);
    await assert.rejects(launchArdia({ executable: "/opt/ardia/bin/ardia", scratch, spawnImpl: recording, startTimeout: 10000 }), /exited/);
    assert.equal(seen[0][0], "/bin/sh");
    assert.deepEqual(seen[0][1].slice(0, 3), ["-c", 'ulimit -c 0; exec "$0" "$@"', "/opt/ardia/bin/ardia"]);
    assert.ok(seen[0][1].includes(`--user-data-dir=${scratch}`));
    assert.equal(seen[1][0], "/opt/ardia/bin/ardia");
  });

  it("fails fast when the browser exits before DevTools starts", async () => {
    await assert.rejects(launchArdia({ executable: "/bin/true", scratch, spawnImpl: fakeSpawn(false), startTimeout: 10000 }), /exited/);
  });

  it("retries a transient startup connect failure while the browser is alive", async () => {
    const attempts = [];
    const flaky = (url, options) => {
      attempts.push({ url, timeout: options.timeout, at: Date.now() });
      if (attempts.length === 1) return Promise.reject(new Error(`CDP connection to ${url} timed out after ${options.timeout} ms`));
      if (attempts.length === 2) return Promise.reject(new Error(`CDP connection to ${url} failed: ECONNREFUSED`));
      return connectCdp(url, options);
    };
    const app = await launchArdia({ executable: "/bin/true", scratch, spawnImpl: fakeSpawn(), startTimeout: 10000, connectImpl: flaky });
    try {
      assert.equal(attempts.length, 3);
      assert.ok(attempts.every((a) => a.url === `ws://127.0.0.1:${mock.port}/devtools/browser/mock`));
      assert.ok(attempts.every((a) => a.timeout > 0 && a.timeout <= 15000));
      assert.ok(attempts[1].at - attempts[0].at >= 200);
      assert.equal(app.browser.closed, false);
    } finally {
      assert.equal(await app.close(), true);
    }
  });

  it("stops retrying startup connects once the start timeout is spent", async () => {
    let attempts = 0;
    const refused = (url) => { attempts++; return Promise.reject(new Error(`CDP connection to ${url} failed: ECONNREFUSED`)); };
    const started = Date.now();
    await assert.rejects(launchArdia({ executable: "/bin/true", scratch, spawnImpl: fakeSpawn(), startTimeout: 1200, connectImpl: refused }), /start timeout after \d+ attempts: .*ECONNREFUSED/);
    assert.ok(attempts >= 2);
    assert.ok(Date.now() - started < 8000);
  });

  it("aborts a startup connect promptly when the browser exits mid-connect", async () => {
    let seenSignal = null;
    const hanging = (url, { signal }) => {
      seenSignal = signal;
      sleeper.kill("SIGTERM");
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const started = Date.now();
    await assert.rejects(launchArdia({ executable: "/bin/true", scratch, spawnImpl: fakeSpawn(), startTimeout: 30000, connectImpl: hanging }), /CDP connection aborted: the browser exited/);
    assert.equal(seenSignal.aborted, true);
    assert.ok(Date.now() - started < 5000);
  });

  it("closes a session that opens after the browser exited", async () => {
    let lateSession = null;
    const late = () => {
      sleeper.kill("SIGTERM");
      return new Promise((resolve) => setTimeout(() => {
        lateSession = { closed: false, close() { this.closed = true; return Promise.resolve(); } };
        resolve(lateSession);
      }, 300));
    };
    const started = Date.now();
    await assert.rejects(launchArdia({ executable: "/bin/true", scratch, spawnImpl: fakeSpawn(), startTimeout: 30000, connectImpl: late }), /CDP connection aborted: the browser exited/);
    assert.ok(Date.now() - started < 5000);
    for (let waited = 0; !lateSession?.closed && waited < 2000; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(lateSession?.closed, true);
  });

  it("aborts startup connect retries promptly when the browser exits between attempts", async () => {
    let attempts = 0;
    const refused = (url) => {
      attempts++;
      sleeper.kill("SIGTERM");
      return Promise.reject(new Error(`CDP connection to ${url} failed: ECONNREFUSED`));
    };
    const started = Date.now();
    await assert.rejects(launchArdia({ executable: "/bin/true", scratch, spawnImpl: fakeSpawn(), startTimeout: 30000, connectImpl: refused }), /CDP connection aborted: the browser exited/);
    assert.equal(attempts, 1);
    assert.ok(Date.now() - started < 5000);
  });

  it("stops a startup connect when the check is cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("check stopped");
    let seenSignal = null;
    const hanging = (url, { signal }) => {
      seenSignal = signal;
      setTimeout(() => controller.abort(reason), 50);
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const started = Date.now();
    await assert.rejects(withSignal(controller.signal, () => launchArdia({ executable: "/bin/true", scratch, spawnImpl: fakeSpawn(), startTimeout: 30000, connectImpl: hanging })), /check stopped/);
    assert.equal(seenSignal.aborted, true);
    assert.ok(Date.now() - started < 5000);
  });

  it("closes a session that arrives after the check was cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("check stopped");
    let session = null;
    const racing = async (url, options) => {
      session = await connectCdp(url, { timeout: options.timeout });
      controller.abort(reason);
      return session;
    };
    await assert.rejects(withSignal(controller.signal, () => launchArdia({ executable: "/bin/true", scratch, spawnImpl: fakeSpawn(), startTimeout: 30000, connectImpl: racing })), /check stopped/);
    for (let waited = 0; !session.closed && waited < 2000; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(session.closed, true);
  });

  it("returns the main shell from its own scan instead of scanning again", async () => {
    const stuck = await startMockCdp({
      targets: [
        { id: "shell-main", type: "page", url: "chrome://ardia/index.html" },
        { id: "shell-stuck", type: "page", url: "chrome://ardia/index.html" },
      ],
      handlers: {
        "Runtime.evaluate": (params, { targetId }) => (targetId === "shell-stuck" ? stuck.NO_REPLY : evaluateIn(shells.main.context, params.expression)),
      },
    });
    const app = new ArdiaApp({ child: new EventEmitter(), scratch: tmpdir(), logPath: "/dev/null", label: "stuck" });
    app.port = stuck.port;
    try {
      const started = Date.now();
      const main = await app.mainShell({ timeout: 1000 });
      assert.equal(main.windowId, "main");
      assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`);
      assert.equal(stuck.received.filter((m) => m.method === "Runtime.evaluate" && m.targetId === "shell-stuck").length, 1);
    } finally {
      for (const session of app.connections.values()) await session.close().catch(() => {});
      await stuck.close();
    }
  });
});

describe("shell probes against stalled renderers", () => {
  it("stop probing once the polling deadline passes", async () => {
    const sockets = new Set();
    const server = http.createServer((request, response) => {
      const port = server.address().port;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([1, 2, 3, 4].map((n) => ({ id: `shell-${n}`, type: "page", url: "chrome://ardia/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/shell-${n}` }))));
    });
    server.on("upgrade", (request, socket) => { sockets.add(socket); socket.on("error", () => {}); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const app = new ArdiaApp({ child: new EventEmitter(), scratch: tmpdir(), logPath: "/dev/null", label: "stalled" });
    app.port = server.address().port;
    try {
      const started = Date.now();
      await assert.rejects(app.mainShell({ timeout: 300 }), /Timed out after 300 ms waiting for a browser shell renderer/);
      assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
      assert.equal(sockets.size, 1);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  });
});

describe("shell probes against renderers that never finish setup", () => {
  it("drop a session whose setup outlives the polling deadline", async () => {
    const mock = await startMockCdp({
      targets: [{ id: "shell-1", type: "page", url: "chrome://ardia/index.html" }, { id: "shell-2", type: "page", url: "chrome://ardia/index.html" }],
      handlers: { "Runtime.enable": () => mock.NO_REPLY },
    });
    const app = new ArdiaApp({ child: new EventEmitter(), scratch: tmpdir(), logPath: "/dev/null", label: "setup" });
    app.port = mock.port;
    try {
      const started = Date.now();
      await assert.rejects(app.mainShell({ timeout: 300 }), /Timed out after 300 ms/);
      assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
      assert.equal(app.connections.size, 0);
      assert.equal(mock.received.filter((m) => m.method === "Runtime.enable").length, 1);
    } finally {
      await mock.close();
    }
  });
});

describe("shell probes against slow or dropped renderers", () => {
  it("gives setup commands their own time after a quick handshake", async () => {
    const mock = await startMockCdp({
      targets: [{ id: "shell-main", type: "page", url: "chrome://ardia/index.html" }],
      handlers: {
        "Runtime.enable": () => new Promise((resolve) => setTimeout(() => resolve({}), 5300)),
        "Runtime.evaluate": () => ({ result: { type: "object", value: { windowId: "main", profileId: "default", pageProfile: null, startup: true, utility: null, privateWindow: false, ready: true } } }),
      },
    });
    const app = new ArdiaApp({ child: new EventEmitter(), scratch: tmpdir(), logPath: "/dev/null", label: "slow-setup" });
    app.port = mock.port;
    try {
      const main = await app.mainShell({ timeout: 9000 });
      assert.equal(main.windowId, "main");
      assert.equal(main.session.closed, false);
    } finally {
      for (const session of app.connections.values()) await session.close().catch(() => {});
      await mock.close();
    }
  });

  it("reconnects to the startup renderer when its socket drops mid-scan", async () => {
    let mock = null;
    let dropped = false;
    mock = await startMockCdp({
      targets: [{ id: "shell-main", type: "page", url: "chrome://ardia/index.html" }, { id: "shell-second", type: "page", url: "chrome://ardia/index.html" }],
      handlers: {
        "Runtime.evaluate": async (params, { targetId }) => {
          const windowId = targetId.replace("shell-", "");
          if (windowId === "second" && !dropped) {
            dropped = true;
            mock.peers.find((peer) => peer.targetId === "shell-main").close();
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return { result: { type: "object", value: { windowId, profileId: "default", pageProfile: null, startup: windowId === "main", utility: null, privateWindow: false, ready: true } } };
        },
      },
    });
    const app = new ArdiaApp({ child: new EventEmitter(), scratch: tmpdir(), logPath: "/dev/null", label: "dropped" });
    app.port = mock.port;
    try {
      const main = await app.mainShell({ timeout: 5000 });
      assert.equal(main.windowId, "main");
      assert.equal(main.session.closed, false);
      assert.equal((await main.eval("1")).windowId, "main");
    } finally {
      for (const session of app.connections.values()) await session.close().catch(() => {});
      await mock.close();
    }
  });

  it("still finds a ready renderer whose Log.enable never answers", async () => {
    const mock = await startMockCdp({
      targets: [{ id: "shell-main", type: "page", url: "chrome://ardia/index.html" }],
      handlers: {
        "Log.enable": () => mock.NO_REPLY,
        "Runtime.evaluate": () => ({ result: { type: "object", value: { windowId: "main", profileId: "default", pageProfile: null, startup: true, utility: null, privateWindow: false, ready: true } } }),
      },
    });
    const app = new ArdiaApp({ child: new EventEmitter(), scratch: tmpdir(), logPath: "/dev/null", label: "no-log" });
    app.port = mock.port;
    try {
      const main = await app.mainShell({ timeout: 12500 });
      assert.equal(main.windowId, "main");
      assert.equal(main.session.closed, false);
    } finally {
      for (const session of app.connections.values()) await session.close().catch(() => {});
      await mock.close();
    }
  });

  it("keeps live candidates from the first scan when the recovery scan has no time left", async () => {
    let calls = 0;
    const app = new ArdiaApp({ child: new EventEmitter(), scratch: tmpdir(), logPath: "/dev/null", label: "keep-live" });
    const liveSession = { closed: false, close: async () => {} };
    const closedSession = { closed: true, close: async () => {} };
    app.shells = async () => {
      calls += 1;
      if (calls === 1) {
        return [
          { target: { id: "shell-main" }, session: liveSession, windowId: "main", profileId: "default", pageProfile: null, startup: true, utility: null, privateWindow: false, ready: true },
          { target: { id: "shell-second" }, session: closedSession, windowId: "second", profileId: "default", pageProfile: null, startup: false, utility: null, privateWindow: false, ready: true },
        ];
      }
      return [];
    };
    const main = await app.mainShell({ timeout: 1000 });
    assert.equal(calls, 2);
    assert.equal(main.windowId, "main");
    assert.equal(main.session, liveSession);
  });
});
