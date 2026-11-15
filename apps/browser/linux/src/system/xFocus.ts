import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { desktopSession } from "../paths";

export type XFocus = { root: number; focus: number; active: number | null };

const NONE = 0;
const POINTER_ROOT = 1;
const QUERY_TIMEOUT_MS = 500;
const COOKIE = "MIT-MAGIC-COOKIE-1";
const FAMILY_LOCAL = 256;
const FAMILY_WILD = 65535;
const ATOM_WINDOW = 33;
const OP_INTERN_ATOM = 16;
const OP_GET_PROPERTY = 20;
const OP_GET_INPUT_FOCUS = 43;

type Display = { path: string | null; host: string; port: number; number: string; screen: number };

export function parseDisplay(display: string | undefined): Display | null {
  const match = /^(.*):(\d+)(?:\.(\d+))?$/.exec(display ?? "");
  if (!match) return null;
  const [, host = "", number = "0", screen = "0"] = match;
  const local = !host || host === "unix";
  return {
    path: host.startsWith("/") ? host : local ? `/tmp/.X11-unix/X${number}` : null,
    host,
    port: 6000 + Number(number),
    number,
    screen: Number(screen),
  };
}

const pad4 = (length: number) => (4 - (length % 4)) % 4;

function readCookie(display: Display): Buffer | null {
  let file: Buffer;
  try {
    file = readFileSync(desktopSession().xAuthority || join(homedir(), ".Xauthority"));
  } catch {
    return null;
  }
  const local = !display.host || display.host === "unix" || display.path !== null;
  const wantedHost = local ? hostname() : display.host;
  let at = 0;
  const field = () => {
    const length = file.readUInt16BE(at);
    const value = file.subarray(at + 2, at + 2 + length);
    at += 2 + length;
    return value;
  };
  try {
    while (at + 2 <= file.length) {
      const family = file.readUInt16BE(at);
      at += 2;
      const address = field().toString("latin1");
      const number = field().toString("latin1");
      const name = field().toString("latin1");
      const data = field();
      if (name !== COOKIE || (number && number !== display.number)) continue;
      if (family === FAMILY_WILD || (family === FAMILY_LOCAL && local && address === wantedHost) || (!local && address === wantedHost)) return Buffer.from(data);
    }
  } catch {}
  return null;
}

function setupRequest(cookie: Buffer | null): Buffer {
  const name = cookie ? Buffer.from(COOKIE, "latin1") : Buffer.alloc(0);
  const data = cookie ?? Buffer.alloc(0);
  const request = Buffer.alloc(12 + name.length + pad4(name.length) + data.length + pad4(data.length));
  request.writeUInt8(0x6c, 0);
  request.writeUInt16LE(11, 2);
  request.writeUInt16LE(0, 4);
  request.writeUInt16LE(name.length, 6);
  request.writeUInt16LE(data.length, 8);
  name.copy(request, 12);
  data.copy(request, 12 + name.length + pad4(name.length));
  return request;
}

function rootOf(setup: Buffer, screen: number): number {
  const vendorLength = setup.readUInt16LE(24);
  const screens = setup.readUInt8(28);
  const formats = setup.readUInt8(29);
  if (screen >= screens) throw new Error(`the X server has no screen ${screen}`);
  let at = 40 + vendorLength + pad4(vendorLength) + formats * 8;
  for (let index = 0; index < screen; index++) {
    const depths = setup.readUInt8(at + 39);
    at += 40;
    for (let depth = 0; depth < depths; depth++) at += 8 + setup.readUInt16LE(at + 2) * 24;
  }
  return setup.readUInt32LE(at);
}

function internAtom(name: string): Buffer {
  const bytes = Buffer.from(name, "latin1");
  const request = Buffer.alloc(8 + bytes.length + pad4(bytes.length));
  request.writeUInt8(OP_INTERN_ATOM, 0);
  request.writeUInt8(1, 1);
  request.writeUInt16LE(request.length / 4, 2);
  request.writeUInt16LE(bytes.length, 4);
  bytes.copy(request, 8);
  return request;
}

function getInputFocus(): Buffer {
  const request = Buffer.alloc(4);
  request.writeUInt8(OP_GET_INPUT_FOCUS, 0);
  request.writeUInt16LE(1, 2);
  return request;
}

function getProperty(window: number, property: number): Buffer {
  const request = Buffer.alloc(24);
  request.writeUInt8(OP_GET_PROPERTY, 0);
  request.writeUInt16LE(6, 2);
  request.writeUInt32LE(window, 4);
  request.writeUInt32LE(property, 8);
  request.writeUInt32LE(ATOM_WINDOW, 12);
  request.writeUInt32LE(0, 16);
  request.writeUInt32LE(1, 20);
  return request;
}

type Waiting = { size: (buffer: Buffer) => number | null; resolve: (message: Buffer) => void; reject: (error: Error) => void };

class Reader {
  private buffered = Buffer.alloc(0);
  private waiting: Waiting | null = null;
  private failure: Error | null = null;
  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      this.drain();
    });
    const fail = (error: Error) => {
      this.failure ??= error;
      this.drain();
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("the X server closed the connection")));
  }
  read(size: Waiting["size"]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiting = { size, resolve, reject };
      this.drain();
    });
  }
  private drain() {
    const waiting = this.waiting;
    if (!waiting) return;
    const size = waiting.size(this.buffered);
    if (size !== null && this.buffered.length >= size) {
      const message = this.buffered.subarray(0, size);
      this.buffered = this.buffered.subarray(size);
      this.waiting = null;
      waiting.resolve(message);
    } else if (this.failure) {
      this.waiting = null;
      waiting.reject(this.failure);
    }
  }
}

const setupSize = (buffer: Buffer) => (buffer.length >= 8 ? 8 + buffer.readUInt16LE(6) * 4 : null);
const replySize = (buffer: Buffer) => (buffer.length >= 8 ? (buffer.readUInt8(0) === 1 ? 32 + buffer.readUInt32LE(4) * 4 : 32) : null);

async function reply(reader: Reader, what: string): Promise<Buffer> {
  const message = await reader.read(replySize);
  if (message.readUInt8(0) !== 1) throw new Error(`the X server refused ${what} (error ${message.readUInt8(1)})`);
  return message;
}

function connect(display: Display): Socket {
  return display.path ? createConnection({ path: display.path }) : createConnection({ host: display.host, port: display.port });
}

async function ask(socket: Socket, display: Display): Promise<XFocus> {
  const reader = new Reader(socket);
  socket.write(setupRequest(readCookie(display)));
  const setup = await reader.read(setupSize);
  if (setup.readUInt8(0) !== 1) throw new Error(`the X server refused the connection: ${setup.subarray(8, 8 + setup.readUInt8(1)).toString("latin1")}`);
  const root = rootOf(setup, display.screen);
  socket.write(Buffer.concat([internAtom("_NET_ACTIVE_WINDOW"), getInputFocus()]));
  const atom = (await reply(reader, "InternAtom")).readUInt32LE(8);
  const focus = (await reply(reader, "GetInputFocus")).readUInt32LE(8);
  if (atom === NONE) return { root, focus, active: null };
  socket.write(getProperty(root, atom));
  const property = await reply(reader, "GetProperty");
  const format = property.readUInt8(1);
  const type = property.readUInt32LE(8);
  const length = property.readUInt32LE(16);
  const active = type === ATOM_WINDOW && format === 32 && length >= 1 ? property.readUInt32LE(32) : null;
  return { root, focus, active };
}

export async function queryXFocus(displayName = desktopSession().display ?? undefined): Promise<XFocus> {
  const display = parseDisplay(displayName);
  if (!display) throw new Error(`can't read DISPLAY ${JSON.stringify(displayName ?? "")}`);
  const socket = connect(display);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ask(socket, display),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the X server didn't answer")), QUERY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

export function nothingElseFocused({ root, focus, active }: XFocus, ours: ReadonlySet<number>): boolean {
  if (active !== null) return active === NONE || ours.has(active);
  return focus === NONE || focus === POINTER_ROOT || focus === root || ours.has(focus);
}
