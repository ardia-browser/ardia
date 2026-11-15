import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { app, BrowserWindow } from "electron";

const scratch = mkdtempSync(join(tmpdir(), "ardia-focus-return-"));
const socketPath = join(scratch, "x11.sock");
const ROOT = 0x2a1;
const ACTIVE_ATOM = 301;
const OURS = 0x400005;
const OTHER_APP = 0x600007;

type XState = { focus: number; active: number | null | "absent" };
const x: XState = { focus: 0, active: "absent" };
let queries = 0;

function setupReply(): Buffer {
  const vendor = Buffer.from("fake", "latin1");
  const body = Buffer.alloc(32 + vendor.length + 40);
  body.writeUInt16LE(vendor.length, 16);
  body.writeUInt8(1, 20);
  body.writeUInt8(0, 21);
  vendor.copy(body, 32);
  body.writeUInt32LE(ROOT, 32 + vendor.length);
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0);
  header.writeUInt16LE(11, 2);
  header.writeUInt16LE(body.length / 4, 6);
  return Buffer.concat([header, body]);
}

function replyTo(opcode: number, request: Buffer, sequence: number): Buffer {
  const reply = Buffer.alloc(32);
  reply.writeUInt8(1, 0);
  reply.writeUInt16LE(sequence, 2);
  if (opcode === 16) {
    const name = request.subarray(8, 8 + request.readUInt16LE(4)).toString("latin1");
    reply.writeUInt32LE(name === "_NET_ACTIVE_WINDOW" && x.active !== "absent" ? ACTIVE_ATOM : 0, 8);
    return reply;
  }
  if (opcode === 43) {
    reply.writeUInt32LE(x.focus, 8);
    return reply;
  }
  if (opcode === 20) {
    if (x.active === "absent" || x.active === null) return reply;
    const withValue = Buffer.alloc(36);
    reply.copy(withValue);
    withValue.writeUInt8(32, 1);
    withValue.writeUInt32LE(1, 4);
    withValue.writeUInt32LE(33, 8);
    withValue.writeUInt32LE(1, 16);
    withValue.writeUInt32LE(x.active, 32);
    return withValue;
  }
  const error = Buffer.alloc(32);
  error.writeUInt8(1, 1);
  error.writeUInt16LE(sequence, 2);
  return error;
}

const server: Server = createServer((socket) => {
  queries++;
  let buffered = Buffer.alloc(0);
  let ready = false;
  let sequence = 0;
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (!ready) {
      if (buffered.length < 12) return;
      const pad = (n: number) => (4 - (n % 4)) % 4;
      const nameLength = buffered.readUInt16LE(6);
      const dataLength = buffered.readUInt16LE(8);
      const size = 12 + nameLength + pad(nameLength) + dataLength + pad(dataLength);
      if (buffered.length < size) return;
      buffered = buffered.subarray(size);
      ready = true;
      socket.write(setupReply());
    }
    while (buffered.length >= 4 && buffered.length >= buffered.readUInt16LE(2) * 4) {
      const size = buffered.readUInt16LE(2) * 4;
      const request = buffered.subarray(0, size);
      buffered = buffered.subarray(size);
      socket.write(replyTo(request.readUInt8(0), request, ++sequence));
    }
  });
  socket.on("error", () => {});
});
await new Promise<void>((resolve) => server.listen(socketPath, resolve));

process.env.DISPLAY = `${socketPath}:0`;
process.env.XAUTHORITY = join(scratch, "no-xauthority");
delete process.env.WAYLAND_DISPLAY;
delete process.env.XDG_SESSION_TYPE;
delete process.env.ELECTRON_OZONE_PLATFORM_HINT;

class FakeWindow {
  focused = 0;
  readonly xid: number;
  constructor(xid: number) {
    this.xid = xid;
  }
  isDestroyed = () => false;
  isVisible = () => true;
  isMinimized = () => false;
  isFocusable = () => true;
  focus = () => void this.focused++;
  getNativeWindowHandle = () => {
    const handle = Buffer.alloc(8);
    handle.writeUInt32LE(this.xid, 0);
    return handle;
  };
}

let focusedWindow: FakeWindow | null = null;
let allWindows: FakeWindow[] = [];
const Windows = BrowserWindow as unknown as { getFocusedWindow: () => unknown; getAllWindows: () => unknown[] };
Windows.getFocusedWindow = () => focusedWindow;
Windows.getAllWindows = () => allWindows;

const { installFocusReturn, returnFocus } = await import("./focusReturn.ts");
installFocusReturn();

after(() => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

let window: FakeWindow;
beforeEach(() => {
  window = new FakeWindow(OURS);
  allWindows = [window];
  focusedWindow = null;
  queries = 0;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
const ask = () => returnFocus(window as unknown as BrowserWindow);

test("with no window manager and X focus gone to nothing, focus comes back", async () => {
  x.focus = 0;
  x.active = "absent";
  ask();
  await settle();
  assert.equal(window.focused, 1);
});

test("with no window manager and focus on the root window or PointerRoot, focus comes back", async () => {
  for (const focus of [ROOT, 1]) {
    window.focused = 0;
    x.focus = focus;
    x.active = "absent";
    ask();
    await settle();
    assert.equal(window.focused, 1, `focus ${focus}`);
  }
});

test("another application holding X focus keeps it", async () => {
  x.focus = OTHER_APP;
  x.active = "absent";
  ask();
  await settle();
  assert.equal(window.focused, 0);
});

test("under a window manager, another application being active keeps focus", async () => {
  x.focus = OTHER_APP;
  x.active = OTHER_APP;
  ask();
  await settle();
  assert.equal(window.focused, 0);
});

test("under a window manager with no active window, focus comes back", async () => {
  x.focus = 0x700001;
  x.active = 0;
  ask();
  await settle();
  assert.equal(window.focused, 1);
});

test("with the active-window atom known but never set (no window manager), X focus decides", async () => {
  x.active = null;
  x.focus = 0;
  ask();
  await settle();
  assert.equal(window.focused, 1);
  window.focused = 0;
  x.focus = OTHER_APP;
  ask();
  await settle();
  assert.equal(window.focused, 0);
});

test("our own window being active counts as nothing else focused", async () => {
  x.focus = OURS;
  x.active = OURS;
  ask();
  await settle();
  assert.equal(window.focused, 1);
});

test("an Ardia window gaining focus during the delay cancels the pending return", async () => {
  x.focus = 0;
  x.active = "absent";
  ask();
  const other = new FakeWindow(0x400009);
  app.emit("browser-window-focus", {}, other);
  await settle();
  assert.equal(window.focused, 0);
  assert.equal(queries, 0);
});

test("when the X server can't be asked, focus is left alone", async () => {
  const display = process.env.DISPLAY;
  process.env.DISPLAY = `${join(scratch, "nobody-listens.sock")}:0`;
  x.focus = 0;
  ask();
  await settle();
  process.env.DISPLAY = display;
  assert.equal(window.focused, 0);
});
