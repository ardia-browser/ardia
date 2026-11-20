import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../../../../packages/ardiacore/ios/page_script.js", import.meta.url), "utf8");
const slice = (from, to) => {
  const start = script.indexOf(from);
  const end = script.indexOf(to, start);
  assert.ok(start > 0 && end > start, `page_script.js has ${from.trim()}`);
  return script.slice(start, end);
};
const helper = slice("  const asNative = ", "  const { keys, setPrototypeOf } = Object;\n");
const source = slice("  const displayRequests = new Map();\n", "  const receive = (kind, json) => {\n");
const gate = slice("  const web = ", "  const isTop = ");

const illegal = "Failed to execute 'getDisplayMedia' on 'MediaDevices': Illegal invocation";
const badOptions = "Failed to execute 'getDisplayMedia' on 'MediaDevices': The provided value is not of type 'DisplayMediaStreamOptions'.";

function page({ active = false, policyAllows = true, window = {}, stream = null } = {}) {
  const sent = [];
  const nativeCalls = [];
  const real = new WeakSet();
  class MediaDevices {}
  const nativeGetDisplayMedia = {
    getDisplayMedia() {
      nativeCalls.push(this);
      if (!real.has(this)) return Promise.reject(new TypeError(illegal));
      const options = arguments[0];
      if (options !== undefined && options !== null && typeof options !== "object" && typeof options !== "function")
        return Promise.reject(new TypeError(badOptions));
      return new Promise(() => {});
    },
  }.getDisplayMedia;
  Object.defineProperty(MediaDevices.prototype, "getDisplayMedia", {
    value: nativeGetDisplayMedia,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(MediaDevices.prototype, "getUserMedia", { value: () => Promise.resolve(stream), writable: true, enumerable: true, configurable: true });
  Object.defineProperty(MediaDevices.prototype, "ondevicechange", {
    get() {
      if (!real.has(this)) throw new TypeError("Illegal invocation");
      return null;
    },
    enumerable: true,
    configurable: true,
  });
  const devices = new MediaDevices();
  real.add(devices);
  const otherWindowDevices = new MediaDevices();
  real.add(otherWindowDevices);
  class UserActivation {
    get isActive() {
      return active;
    }
  }
  const navigator = { mediaDevices: devices, userActivation: new UserActivation() };
  const document = { featurePolicy: { allowsFeature: () => policyAllows } };
  const handlers = Object.create(null);
  const install = new Function(
    "window",
    "navigator",
    "document",
    "send",
    "apply",
    "handlers",
    "DOMException",
    `${helper}${source}return { installDisplayMedia, restoreDisplayMedia };`,
  )(window, navigator, document, (kind, data) => sent.push({ kind, data }), Reflect.apply, handlers, DOMException);
  return {
    devices,
    otherWindowDevices,
    proto: MediaDevices.prototype,
    native: nativeGetDisplayMedia,
    shim: MediaDevices.prototype.getDisplayMedia,
    sent,
    nativeCalls,
    install: install.installDisplayMedia,
    restore: install.restoreDisplayMedia,
    handlers,
  };
}

const rejection = async (promise) => {
  try {
    await promise;
  } catch (e) {
    return `${e.name}: ${e.message}`;
  }
  return "resolved";
};

test("Castle's tamper probe (new, then a call on the prototype) asks nothing and leaves no stray rejection, as in Chrome (#903)", async () => {
  const p = page();
  const stray = [];
  const onStray = (reason) => stray.push(reason);
  process.on("unhandledRejection", onStray);
  try {
    for (const call of [(fn, proto) => fn.call(proto), (fn, proto) => fn.apply(proto)]) {
      try {
        let constructed = new p.shim();
        const t = call(p.shim, p.proto);
        if (t && typeof t.then === "function") t.catch(() => {});
        throw Error();
      } catch (e) {
        assert.equal(e.constructor, TypeError);
      }
    }
    assert.throws(() => new p.shim(), TypeError);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onStray);
  }
  assert.deepEqual(stray, []);
  assert.deepEqual(p.sent, []);
});

test("the shim looks like the native method where pages check", () => {
  const { shim } = page();
  assert.equal(typeof shim, "function");
  assert.equal(shim.name, "getDisplayMedia");
  assert.equal(shim.length, 0);
  assert.equal("prototype" in shim, false);
  assert.deepEqual(Reflect.ownKeys(shim).sort(), ["length", "name"]);
  assert.match(Function.prototype.toString.call(shim), /^function (getDisplayMedia)?\(\) \{ \[native code\] \}$/);
  assert.throws(() => Object.create(shim).toString(), TypeError);
  const before = Object.getPrototypeOf(shim);
  assert.throws(() => Object.setPrototypeOf(shim, Object.create(shim)), { name: "TypeError", message: "Cyclic __proto__ value" });
  assert.equal(Object.getPrototypeOf(shim), before);
});

test("calls Chrome refuses get Chrome's own answer and never reach the picker", async () => {
  const p = page({ active: true });
  assert.equal(await rejection(p.shim.call(p.proto)), `TypeError: ${illegal}`);
  assert.equal(await rejection(p.shim.call({})), `TypeError: ${illegal}`);
  assert.equal(await rejection(p.devices.getDisplayMedia("screen")), `TypeError: ${badOptions}`);
  assert.equal(p.nativeCalls.length, 3);
  assert.deepEqual(p.sent, []);
});

test("a request blocked by permissions policy goes to Chrome, which refuses it", async () => {
  const p = page({ active: true, policyAllows: false });
  p.devices.getDisplayMedia({ video: true });
  assert.deepEqual(p.nativeCalls, [p.devices]);
  assert.deepEqual(p.sent, []);
});

test("a page's own request without a click is refused; with a click it opens the picker", async () => {
  const quiet = page();
  assert.equal(await rejection(quiet.devices.getDisplayMedia({ video: true })), "InvalidStateError: getDisplayMedia() requires transient activation (user gesture).");
  assert.deepEqual(quiet.sent, []);
  const clicked = page({ active: true });
  clicked.devices.getDisplayMedia({ video: true, audio: true });
  assert.deepEqual(clicked.sent, [{ kind: "displayMedia", data: { id: 1, audio: true, systemAudio: true, windowAudio: "system", controller: false } }]);
  assert.deepEqual(clicked.nativeCalls, []);
});

test("the shim is in place as soon as the page script runs, before Ardia's config arrives (#914)", async () => {
  const p = page();
  assert.notEqual(p.shim, p.native);
  assert.equal(await rejection(p.devices.getDisplayMedia()), "InvalidStateError: getDisplayMedia() requires transient activation (user gesture).");
  assert.deepEqual(p.nativeCalls, []);
});

test("config without Ardia's picker gives the page Chrome's own method back, and config with it installs the shim again", () => {
  const p = page();
  p.restore();
  assert.equal(p.proto.getDisplayMedia, p.native);
  p.install();
  assert.notEqual(p.proto.getDisplayMedia, p.native);
  assert.equal(Function.prototype.toString.call(p.proto.getDisplayMedia), "function () { [native code] }");
});

test("config doesn't wrap a page's own wrapper of the shim a second time", () => {
  const p = page();
  const wrapper = function getDisplayMedia(...args) {
    return p.shim.apply(this, args);
  };
  p.proto.getDisplayMedia = wrapper;
  p.install();
  assert.equal(p.proto.getDisplayMedia, wrapper);
  p.restore();
  assert.equal(p.proto.getDisplayMedia, wrapper);
});

test("another window's mediaDevices (a method borrowed across frames) goes to Chrome's own method, where the engine's click rule decides", () => {
  const p = page({ active: true });
  p.shim.call(p.otherWindowDevices, { video: true });
  assert.deepEqual(p.nativeCalls, [p.otherWindowDevices]);
  assert.deepEqual(p.sent, []);
});

const runsIn = (protocol, top, origin) =>
  new Function("location", "window", "self", `${gate}return "bridge";`)({ protocol }, top ? { top: null } : { top: {} }, { origin });
const topWindow = (protocol, origin) => {
  const window = {};
  window.top = window;
  return new Function("location", "window", "self", `${gate}return "bridge";`)({ protocol }, window, { origin });
};

test("the bridge runs in web pages and in same-origin about:blank and srcdoc child frames, not in top-level or opaque blank documents", () => {
  assert.equal(topWindow("https:", "https://meet.example"), "bridge");
  assert.equal(runsIn("about:", false, "https://meet.example"), "bridge");
  assert.equal(runsIn("about:", false, "http://127.0.0.1:8080"), "bridge");
  assert.equal(typeof topWindow("about:", "https://meet.example"), "function");
  assert.equal(typeof runsIn("about:", false, "null"), "function");
  assert.equal(typeof runsIn("data:", false, "null"), "function");
  assert.equal(typeof runsIn("chrome-extension:", false, "chrome-extension://abc"), "function");
});

const blankFrameTail = slice("  const receive = (kind, json) => {\n", "  const frame = Math.random()");

function blankFrame() {
  const sent = [];
  const nativeCalls = [];
  class MediaDevices {}
  const nativeGetDisplayMedia = {
    getDisplayMedia() {
      nativeCalls.push(this);
      return new Promise(() => {});
    },
  }.getDisplayMedia;
  Object.defineProperty(MediaDevices.prototype, "getDisplayMedia", { value: nativeGetDisplayMedia, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(MediaDevices.prototype, "getUserMedia", { value() {}, writable: true, enumerable: true, configurable: true });
  const devices = new MediaDevices();
  class UserActivation {
    get isActive() {
      return true;
    }
  }
  const navigator = { mediaDevices: devices, userActivation: new UserActivation() };
  const guard = (fn) =>
    function () {
      try {
        return Reflect.apply(fn, this, arguments);
      } catch (e) {}
    };
  const receive = new Function(
    "window",
    "navigator",
    "document",
    "send",
    "apply",
    "handlers",
    "DOMException",
    "web",
    "guard",
    "fromJSON",
    `${helper}${source}${blankFrameTail}return null;`,
  )({}, navigator, { featurePolicy: { allowsFeature: () => true } }, (kind, data) => sent.push({ kind, data }), Reflect.apply, Object.create(null), DOMException, false, guard, JSON.parse);
  return { receive, devices, proto: MediaDevices.prototype, native: nativeGetDisplayMedia, sent, nativeCalls };
}

test("a blank or srcdoc frame asks Ardia for its display-media config, and with the picker off a click there uses Chrome's own method", () => {
  const f = blankFrame();
  assert.equal(typeof f.receive, "function");
  assert.deepEqual(f.sent, [{ kind: "displayMediaHello", data: {} }]);
  f.receive("config", "{}");
  assert.equal(f.proto.getDisplayMedia, f.native);
  f.devices.getDisplayMedia({ video: true });
  assert.deepEqual(f.nativeCalls, [f.devices]);
  assert.equal(f.sent.length, 1);
  f.receive("config", JSON.stringify({ displayMediaPicker: true }));
  assert.notEqual(f.proto.getDisplayMedia, f.native);
  f.devices.getDisplayMedia({ video: true });
  assert.equal(f.sent[1].kind, "displayMedia");
  assert.equal(f.nativeCalls.length, 1);
});

function captureWorld() {
  const notCapturing = "Failed to execute 'getSupportedZoomLevels' on 'CaptureController': Not actively capturing.";
  const branded = new WeakSet();
  class CaptureController {
    constructor() {
      branded.add(this);
    }
  }
  Object.defineProperty(CaptureController.prototype, "getSupportedZoomLevels", {
    value: {
      getSupportedZoomLevels() {
        if (!branded.has(this)) throw new TypeError("Illegal invocation");
        throw new DOMException(notCapturing, "InvalidStateError");
      },
    }.getSupportedZoomLevels,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  const states = new WeakMap();
  class MediaStreamTrack {
    get readyState() {
      return states.get(this).readyState;
    }
    getSettings() {
      return { displaySurface: states.get(this).surface };
    }
  }
  const track = (surface) => {
    const t = new MediaStreamTrack();
    states.set(t, { readyState: "live", surface });
    return t;
  };
  const end = (t) => (states.get(t).readyState = "ended");
  const tracks = new WeakMap();
  class MediaStream {
    getVideoTracks() {
      return tracks.get(this);
    }
  }
  const streamOf = (videoTrack) => {
    const s = new MediaStream();
    tracks.set(s, [videoTrack]);
    return s;
  };
  return { window: { CaptureController, MediaStreamTrack, MediaStream }, CaptureController, track, end, streamOf, notCapturing };
}

async function share(world, surface, options) {
  const videoTrack = world.track(surface);
  const p = page({ active: true, window: world.window, stream: world.streamOf(videoTrack) });
  const pending = p.shim.call(p.devices, options);
  const request = p.sent.at(-1);
  p.handlers.displayMedia({ id: request.data.id, sourceId: `${surface}:1`, audio: false });
  await pending;
  return { p, videoTrack, request };
}

test("a site's CaptureController answers for the tab it shares, as Chrome's does, so Meet shows its presenter preview (#2146)", async () => {
  const world = captureWorld();
  const controller = new world.CaptureController();
  assert.throws(() => controller.getSupportedZoomLevels(), { name: "InvalidStateError", message: world.notCapturing });
  const { videoTrack, request } = await share(world, "browser", { video: true, controller });
  assert.equal(request.data.controller, true);
  assert.deepEqual(controller.getSupportedZoomLevels(), []);
  world.end(videoTrack);
  assert.throws(() => controller.getSupportedZoomLevels(), { name: "InvalidStateError" }, "an ended share is no longer capturing");
  assert.throws(() => new world.CaptureController().getSupportedZoomLevels(), { name: "InvalidStateError" }, "a controller never used to share isn't capturing");
});

test("a CaptureController sharing a window or screen says zoom isn't supported there, as Chrome's does", async () => {
  for (const surface of ["window", "monitor"]) {
    const world = captureWorld();
    const controller = new world.CaptureController();
    await share(world, surface, { video: true, controller });
    assert.throws(() => controller.getSupportedZoomLevels(), { name: "NotSupportedError" });
  }
});

test("a share without a controller tells the shell so, and the controller patch looks native and leaves with the shim", async () => {
  const world = captureWorld();
  const native = world.CaptureController.prototype.getSupportedZoomLevels;
  const { p, request } = await share(world, "browser", { video: true });
  assert.equal(request.data.controller, false);
  const patched = world.CaptureController.prototype.getSupportedZoomLevels;
  assert.notEqual(patched, native);
  assert.equal(patched.name, "getSupportedZoomLevels");
  assert.match(Function.prototype.toString.call(patched), /^function (getSupportedZoomLevels)?\(\) \{ \[native code\] \}$/);
  p.restore();
  assert.equal(world.CaptureController.prototype.getSupportedZoomLevels, native);
});

test("a controller that isn't a real CaptureController is refused as Chrome refuses it, and a controller shares only once", async () => {
  const world = captureWorld();
  const p = page({ active: true, window: world.window });
  const refusal = "TypeError: Failed to execute 'getDisplayMedia' on 'MediaDevices': Failed to read the 'controller' property from 'DisplayMediaStreamOptions': Failed to convert value to 'CaptureController'.";
  assert.equal(await rejection(p.devices.getDisplayMedia({ video: true, controller: {} })), refusal);
  assert.equal(await rejection(p.devices.getDisplayMedia({ video: true, controller: Object.create(world.CaptureController.prototype) })), refusal);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(await rejection(p.devices.getDisplayMedia({ video: true, controller: revoked.proxy })), refusal);
  assert.deepEqual(p.nativeCalls, []);
  assert.deepEqual(p.sent, []);
  const callable = Object.assign(() => {}, { video: true, controller: new world.CaptureController() });
  void p.devices.getDisplayMedia(callable);
  assert.equal(p.sent.at(-1).data.controller, true);
  assert.equal(await rejection(p.devices.getDisplayMedia(callable)), "InvalidStateError: A CaptureController object may only be used with a single getDisplayMedia() invocation.");
  p.sent.length = 0;
  const controller = new world.CaptureController();
  void p.devices.getDisplayMedia({ video: true, controller });
  assert.equal(p.sent.length, 1);
  assert.equal(await rejection(p.devices.getDisplayMedia({ video: true, controller })), "InvalidStateError: A CaptureController object may only be used with a single getDisplayMedia() invocation.");
  assert.equal(p.sent.length, 1);
});

test("the controller is read once, and a site's wrapper of getDisplayMedia doesn't keep the controller patch after the picker is turned off", async () => {
  const world = captureWorld();
  const native = world.CaptureController.prototype.getSupportedZoomLevels;
  const videoTrack = world.track("browser");
  const p = page({ active: true, window: world.window, stream: world.streamOf(videoTrack) });
  const controller = new world.CaptureController();
  let reads = 0;
  const options = {
    video: true,
    get controller() {
      if (reads++) throw new Error("read twice");
      return controller;
    },
  };
  const pending = p.shim.call(p.devices, options);
  p.handlers.displayMedia({ id: p.sent.at(-1).data.id, sourceId: "browser:1", audio: false });
  await pending;
  assert.equal(reads, 1);
  assert.deepEqual(controller.getSupportedZoomLevels(), []);
  const shim = p.proto.getDisplayMedia;
  p.proto.getDisplayMedia = function wrapped(...args) {
    return shim.apply(this, args);
  };
  p.restore();
  assert.equal(world.CaptureController.prototype.getSupportedZoomLevels, native);
  p.install();
  assert.notEqual(world.CaptureController.prototype.getSupportedZoomLevels, native, "turning the picker back on patches the controller again, wrapper or not");
});

test("a CaptureController that only appears after the script first ran is still accepted and answered", async () => {
  const world = captureWorld();
  const late = { MediaStream: world.window.MediaStream, MediaStreamTrack: world.window.MediaStreamTrack };
  const videoTrack = world.track("browser");
  const p = page({ active: true, window: late, stream: world.streamOf(videoTrack) });
  late.CaptureController = world.CaptureController;
  const lookalike = await rejection(p.shim.call(p.devices, { video: true, controller: Object.create(world.CaptureController.prototype) }));
  assert.match(lookalike, /^TypeError: /);
  const controller = new world.CaptureController();
  const pending = p.shim.call(p.devices, { video: true, controller });
  assert.equal(p.sent.at(-1)?.data.controller, true);
  p.handlers.displayMedia({ id: p.sent.at(-1).data.id, sourceId: "browser:1", audio: false });
  await pending;
  assert.deepEqual(controller.getSupportedZoomLevels(), []);
});
