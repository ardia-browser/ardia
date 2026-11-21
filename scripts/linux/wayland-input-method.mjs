import { createConnection } from "node:net";
import { join } from "node:path";

const DISPLAY_ID = 1;
const SEAT = "wl_seat";
const MANAGER = "zwp_input_method_manager_v2";
const PASSWORD_PURPOSE = 8;

function encodeString(text) {
  const bytes = Buffer.from(`${text}\0`, "utf8");
  const padded = Buffer.alloc(4 + Math.ceil(bytes.length / 4) * 4);
  padded.writeUInt32LE(bytes.length, 0);
  bytes.copy(padded, 4);
  return padded;
}

function encodeArgs(args) {
  return Buffer.concat(
    args.map((arg) => {
      if (typeof arg === "string") return encodeString(arg);
      const word = Buffer.alloc(4);
      word.writeInt32LE(arg, 0);
      return word;
    }),
  );
}

function readString(body, at) {
  const length = body.readUInt32LE(at);
  const text = length === 0 ? null : body.toString("utf8", at + 4, at + 4 + length - 1);
  return { text, next: at + 4 + Math.ceil(length / 4) * 4 };
}

export class WaylandInputMethod {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 2;
    this.handlers = new Map();
    this.pending = Buffer.alloc(0);
    this.globals = new Map();
    this.dones = 0;
    this.active = false;
    this.pendingActive = false;
    this.purpose = null;
    this.pendingPurpose = null;
    this.failure = null;
    this.waiters = new Set();
    this.handlers.set(DISPLAY_ID, (opcode, body) => {
      if (opcode !== 0) return;
      const { text } = readString(body, 8);
      this.fail(new Error(`wayland error on object ${body.readUInt32LE(0)} code ${body.readUInt32LE(4)}: ${text}`));
    });
    socket.on("data", (data) => this.receive(data));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("the Wayland connection closed")));
  }

  static async connect({ display = process.env.WAYLAND_DISPLAY, runtimeDir = process.env.XDG_RUNTIME_DIR, timeout = 10000 } = {}) {
    if (!display) throw new Error("WAYLAND_DISPLAY is not set");
    const path = display.startsWith("/") ? display : join(runtimeDir ?? "", display);
    const socket = await new Promise((resolve, reject) => {
      const connection = createConnection(path);
      connection.once("connect", () => resolve(connection));
      connection.once("error", reject);
    });
    const method = new WaylandInputMethod(socket);
    try {
      await method.setUp(timeout);
    } catch (error) {
      method.close();
      throw error;
    }
    return method;
  }

  fail(error) {
    if (!this.failure) this.failure = error;
    for (const wake of this.waiters) wake();
  }

  send(objectId, opcode, args = []) {
    const body = encodeArgs(args);
    const header = Buffer.alloc(8);
    header.writeUInt32LE(objectId, 0);
    header.writeUInt32LE(((8 + body.length) << 16) | opcode, 4);
    this.socket.write(Buffer.concat([header, body]));
  }

  newId(handler) {
    const id = this.nextId++;
    this.handlers.set(id, handler);
    return id;
  }

  receive(data) {
    this.pending = Buffer.concat([this.pending, data]);
    while (this.pending.length >= 8) {
      const objectId = this.pending.readUInt32LE(0);
      const word = this.pending.readUInt32LE(4);
      const size = word >>> 16;
      if (size < 8 || this.pending.length < size) break;
      const body = this.pending.subarray(8, size);
      this.handlers.get(objectId)?.(word & 0xffff, body);
      this.pending = this.pending.subarray(size);
    }
    for (const wake of this.waiters) wake();
  }

  async until(test, timeout, what) {
    const deadline = Date.now() + timeout;
    while (!test()) {
      if (this.failure) throw this.failure;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.min(left, 250));
        function done() {
          clearTimeout(timer);
          resolve();
        }
        this.waiters.add(done);
      }).finally(() => this.waiters.clear());
    }
  }

  async roundtrip(timeout = 10000) {
    let done = false;
    const callback = this.newId(() => {
      done = true;
    });
    this.send(DISPLAY_ID, 0, [callback]);
    await this.until(() => done, timeout, "a Wayland roundtrip");
    this.handlers.delete(callback);
  }

  bind(name, timeout) {
    const global = this.globals.get(name);
    if (!global) throw new Error(`the compositor offers no ${name}`);
    const id = this.newId(() => {});
    this.send(this.registry, 0, [global.name, name, 1, id]);
    return id;
  }

  async setUp(timeout) {
    this.registry = this.newId((opcode, body) => {
      if (opcode !== 0) return;
      const { text, next } = readString(body, 4);
      if (!this.globals.has(text)) this.globals.set(text, { name: body.readUInt32LE(0), version: body.readUInt32LE(next) });
    });
    this.send(DISPLAY_ID, 1, [this.registry]);
    await this.roundtrip(timeout);
    const seat = this.bind(SEAT);
    const manager = this.bind(MANAGER);
    this.inputMethod = this.newId((opcode, body) => {
      if (opcode === 0) {
        this.pendingActive = true;
        this.pendingPurpose = null;
      } else if (opcode === 1) {
        this.pendingActive = false;
      } else if (opcode === 4) {
        this.pendingPurpose = body.readUInt32LE(4);
      } else if (opcode === 5) {
        this.dones += 1;
        this.active = this.pendingActive;
        if (this.pendingPurpose !== null) this.purpose = this.pendingPurpose;
      } else if (opcode === 6) {
        this.fail(new Error("another input method already holds the seat"));
      }
    });
    this.send(manager, 0, [seat, this.inputMethod]);
    await this.roundtrip(timeout);
    if (this.failure) throw this.failure;
  }

  async waitActive(timeout = 15000) {
    await this.until(() => this.active, timeout, "a focused text field to activate the input method");
    return { purpose: this.purpose, password: this.purpose === PASSWORD_PURPOSE };
  }

  async preedit(text, timeout = 10000) {
    await this.waitActive(timeout);
    this.send(this.inputMethod, 1, [text, Buffer.byteLength(text), Buffer.byteLength(text)]);
    this.send(this.inputMethod, 3, [this.dones]);
    await this.roundtrip(timeout);
  }

  async commit(text, timeout = 10000) {
    await this.waitActive(timeout);
    this.send(this.inputMethod, 0, [text]);
    this.send(this.inputMethod, 3, [this.dones]);
    await this.roundtrip(timeout);
  }

  close() {
    this.socket.destroy();
  }
}
