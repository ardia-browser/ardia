import { createConnection, type Socket } from "node:net";
import { userInfo } from "node:os";

export type Variant = { signature: string; value: unknown };
export type Message = {
  type: number;
  serial: number;
  path?: string;
  interface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  sender?: string;
  signature: string;
  body: unknown[];
};
export type Call = { destination: string; path: string; interface: string; member: string; signature?: string; body?: unknown[] };

const METHOD_CALL = 1;
const METHOD_RETURN = 2;
const ERROR = 3;
const SIGNAL = 4;
const FIELD = { path: 1, interface: 2, member: 3, errorName: 4, replySerial: 5, destination: 6, sender: 7, signature: 8 } as const;
const SYSTEM_BUS = "unix:path=/var/run/dbus/system_bus_socket";
const CALL_DEADLINE_MS = 10000;

export const variant = (signature: string, value: unknown): Variant => ({ signature, value });

function alignmentOf(code: string): number {
  switch (code) {
    case "y":
    case "g":
    case "v":
      return 1;
    case "n":
    case "q":
      return 2;
    case "b":
    case "i":
    case "u":
    case "s":
    case "o":
    case "a":
    case "h":
      return 4;
    default:
      return 8;
  }
}

function completeType(signature: string, at: number): number {
  const code = signature[at];
  if (code === "a") return completeType(signature, at + 1);
  if (code === "(" || code === "{") {
    const close = code === "(" ? ")" : "}";
    let index = at + 1;
    while (signature[index] !== close) index = completeType(signature, index);
    return index + 1;
  }
  return at + 1;
}

export function splitSignature(signature: string): string[] {
  const types: string[] = [];
  for (let index = 0; index < signature.length; ) {
    const end = completeType(signature, index);
    types.push(signature.slice(index, end));
    index = end;
  }
  return types;
}

class Writer {
  bytes: number[] = [];
  pad(alignment: number) {
    while (this.bytes.length % alignment) this.bytes.push(0);
  }
  raw(buffer: Buffer) {
    for (const byte of buffer) this.bytes.push(byte);
  }
  uint32(value: number) {
    this.pad(4);
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value >>> 0);
    this.raw(buffer);
  }
  write(type: string, value: unknown): void {
    const code = type[0];
    switch (code) {
      case "y":
        this.bytes.push(Number(value) & 0xff);
        return;
      case "b":
        return this.uint32(value ? 1 : 0);
      case "u":
      case "h":
        return this.uint32(Number(value));
      case "i": {
        this.pad(4);
        const buffer = Buffer.alloc(4);
        buffer.writeInt32LE(Number(value));
        return this.raw(buffer);
      }
      case "n":
      case "q": {
        this.pad(2);
        const buffer = Buffer.alloc(2);
        if (code === "n") buffer.writeInt16LE(Number(value));
        else buffer.writeUInt16LE(Number(value));
        return this.raw(buffer);
      }
      case "d":
      case "t":
      case "x": {
        this.pad(8);
        const buffer = Buffer.alloc(8);
        if (code === "d") buffer.writeDoubleLE(Number(value));
        else if (code === "t") buffer.writeBigUInt64LE(BigInt(value as number | bigint));
        else buffer.writeBigInt64LE(BigInt(value as number | bigint));
        return this.raw(buffer);
      }
      case "s":
      case "o": {
        const text = Buffer.from(String(value), "utf8");
        this.uint32(text.length);
        this.raw(text);
        this.bytes.push(0);
        return;
      }
      case "g": {
        const text = Buffer.from(String(value), "utf8");
        this.bytes.push(text.length);
        this.raw(text);
        this.bytes.push(0);
        return;
      }
      case "v": {
        const inner = value as Variant;
        this.write("g", inner.signature);
        return this.write(inner.signature, inner.value);
      }
      case "a": {
        const element = type.slice(1);
        this.pad(4);
        const lengthAt = this.bytes.length;
        this.uint32(0);
        this.pad(alignmentOf(element[0]!));
        const start = this.bytes.length;
        const items = element[0] === "{" ? Object.entries(value as Record<string, unknown>) : (value as unknown[]);
        for (const item of items) this.write(element, item);
        const length = this.bytes.length - start;
        const buffer = Buffer.alloc(4);
        buffer.writeUInt32LE(length);
        for (let index = 0; index < 4; index++) this.bytes[lengthAt + index] = buffer[index]!;
        return;
      }
      case "(":
      case "{": {
        this.pad(8);
        const fields = splitSignature(type.slice(1, -1));
        const values = value as unknown[];
        fields.forEach((field, index) => this.write(field, values[index]));
        return;
      }
      default:
        throw new Error(`D-Bus type ${type} isn't supported`);
    }
  }
}

class Reader {
  private readonly buffer: Buffer;
  offset: number;
  constructor(buffer: Buffer, offset = 0) {
    this.buffer = buffer;
    this.offset = offset;
  }
  align(alignment: number) {
    this.offset = Math.ceil(this.offset / alignment) * alignment;
  }
  read(type: string): unknown {
    const code = type[0];
    const buffer = this.buffer;
    switch (code) {
      case "y":
        return buffer[this.offset++];
      case "b":
      case "u":
      case "h": {
        this.align(4);
        const value = buffer.readUInt32LE(this.offset);
        this.offset += 4;
        return code === "b" ? value !== 0 : value;
      }
      case "i": {
        this.align(4);
        const value = buffer.readInt32LE(this.offset);
        this.offset += 4;
        return value;
      }
      case "n":
      case "q": {
        this.align(2);
        const value = code === "n" ? buffer.readInt16LE(this.offset) : buffer.readUInt16LE(this.offset);
        this.offset += 2;
        return value;
      }
      case "d":
      case "t":
      case "x": {
        this.align(8);
        const value = code === "d" ? buffer.readDoubleLE(this.offset) : Number(code === "t" ? buffer.readBigUInt64LE(this.offset) : buffer.readBigInt64LE(this.offset));
        this.offset += 8;
        return value;
      }
      case "s":
      case "o": {
        this.align(4);
        const length = buffer.readUInt32LE(this.offset);
        this.offset += 4;
        const text = buffer.toString("utf8", this.offset, this.offset + length);
        this.offset += length + 1;
        return text;
      }
      case "g": {
        const length = buffer[this.offset++]!;
        const text = buffer.toString("utf8", this.offset, this.offset + length);
        this.offset += length + 1;
        return text;
      }
      case "v": {
        const signature = this.read("g") as string;
        return { signature, value: this.read(signature) } satisfies Variant;
      }
      case "a": {
        const element = type.slice(1);
        this.align(4);
        const length = buffer.readUInt32LE(this.offset);
        this.offset += 4;
        this.align(alignmentOf(element[0]!));
        const end = this.offset + length;
        if (element[0] === "{") {
          const entries: Record<string, unknown> = {};
          while (this.offset < end) {
            const [key, value] = this.read(element) as [unknown, unknown];
            entries[String(key)] = value;
          }
          return entries;
        }
        const items: unknown[] = [];
        while (this.offset < end) items.push(this.read(element));
        return items;
      }
      case "(":
      case "{": {
        this.align(8);
        return splitSignature(type.slice(1, -1)).map((field) => this.read(field));
      }
      default:
        throw new Error(`D-Bus type ${type} isn't supported`);
    }
  }
}

function encode(message: { type: number; serial: number; fields: [number, Variant][]; signature: string; body: unknown[] }): Buffer {
  const body = new Writer();
  splitSignature(message.signature).forEach((type, index) => body.write(type, message.body[index]));
  const fields = message.signature ? [...message.fields, [FIELD.signature, variant("g", message.signature)] as [number, Variant]] : message.fields;
  const header = new Writer();
  header.bytes.push("l".charCodeAt(0), message.type, 0, 1);
  header.uint32(body.bytes.length);
  header.uint32(message.serial);
  header.write("a(yv)", fields);
  header.pad(8);
  return Buffer.concat([Buffer.from(header.bytes), Buffer.from(body.bytes)]);
}

function messageLength(buffer: Buffer): number | null {
  if (buffer.length < 16) return null;
  const little = buffer[0] === "l".charCodeAt(0);
  const bodyLength = little ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
  const fieldsLength = little ? buffer.readUInt32LE(12) : buffer.readUInt32BE(12);
  const headerLength = Math.ceil((16 + fieldsLength) / 8) * 8;
  return headerLength + bodyLength;
}

function decode(buffer: Buffer): Message {
  if (buffer[0] !== "l".charCodeAt(0)) throw new Error("big-endian D-Bus messages aren't supported");
  const reader = new Reader(buffer, 4);
  const bodyLength = reader.read("u") as number;
  const serial = reader.read("u") as number;
  const fields = reader.read("a(yv)") as [number, Variant][];
  reader.align(8);
  const message: Message = { type: buffer[1]!, serial, signature: "", body: [] };
  for (const [code, { value }] of fields) {
    if (code === FIELD.path) message.path = String(value);
    else if (code === FIELD.interface) message.interface = String(value);
    else if (code === FIELD.member) message.member = String(value);
    else if (code === FIELD.errorName) message.errorName = String(value);
    else if (code === FIELD.replySerial) message.replySerial = Number(value);
    else if (code === FIELD.sender) message.sender = String(value);
    else if (code === FIELD.signature) message.signature = String(value);
  }
  const end = reader.offset + bodyLength;
  message.body = splitSignature(message.signature).map((type) => reader.read(type));
  if (reader.offset > end) throw new Error("a D-Bus message body overran its length");
  return message;
}

function socketPath(address: string): string {
  for (const option of address.split(";")) {
    if (!option.startsWith("unix:")) continue;
    const parts = Object.fromEntries(option.slice(5).split(",").map((pair) => pair.split("=") as [string, string]));
    if (parts.path) return decodeURIComponent(parts.path);
    if (parts.abstract) return `\0${decodeURIComponent(parts.abstract)}`;
  }
  throw new Error(`no unix socket in the D-Bus address ${address}`);
}

export class DBusConnection {
  private socket: Socket | null = null;
  private pending = Buffer.alloc(0);
  private serial = 0;
  private readonly replies = new Map<number, { resolve: (message: Message) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly signalListeners = new Set<(message: Message) => void>();
  private readonly closeListeners = new Set<() => void>();
  uniqueName = "";

  static async system(address = process.env.DBUS_SYSTEM_BUS_ADDRESS || SYSTEM_BUS): Promise<DBusConnection> {
    const connection = new DBusConnection();
    await connection.open(address);
    return connection;
  }

  private open(address: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath(address));
      let authenticated = false;
      let greeting = "";
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", fail);
      socket.on("connect", () => {
        socket.write(Buffer.from([0]));
        socket.write(`AUTH EXTERNAL ${Buffer.from(String(userInfo().uid)).toString("hex")}\r\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        if (!authenticated) {
          greeting += chunk.toString("latin1");
          if (!greeting.includes("\r\n")) return;
          if (!greeting.startsWith("OK ")) return fail(new Error(`D-Bus refused the connection: ${greeting.trim()}`));
          authenticated = true;
          socket.write("BEGIN\r\n");
          this.socket = socket;
          socket.off("error", fail);
          socket.on("error", () => this.closed());
          socket.on("close", () => this.closed());
          void this.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "Hello" })
            .then((reply) => {
              this.uniqueName = String(reply[0] ?? "");
              resolve();
            })
            .catch(fail);
          return;
        }
        this.receive(chunk);
      });
    });
  }

  private closed() {
    if (!this.socket) return;
    this.socket = null;
    for (const [serial, reply] of this.replies) {
      clearTimeout(reply.timer);
      reply.reject(new Error("the D-Bus connection closed"));
      this.replies.delete(serial);
    }
    for (const listener of this.closeListeners) listener();
  }

  private receive(chunk: Buffer) {
    this.pending = Buffer.concat([this.pending, chunk]);
    for (;;) {
      const length = messageLength(this.pending);
      if (length === null || this.pending.length < length) return;
      const raw = this.pending.subarray(0, length);
      this.pending = this.pending.subarray(length);
      let message: Message;
      try {
        message = decode(raw);
      } catch {
        continue;
      }
      if ((message.type === METHOD_RETURN || message.type === ERROR) && message.replySerial !== undefined) {
        const waiting = this.replies.get(message.replySerial);
        if (!waiting) continue;
        this.replies.delete(message.replySerial);
        clearTimeout(waiting.timer);
        if (message.type === ERROR) waiting.reject(Object.assign(new Error(`${message.errorName}: ${String(message.body[0] ?? "")}`), { name: message.errorName ?? "DBusError" }));
        else waiting.resolve(message);
      } else if (message.type === SIGNAL) {
        for (const listener of this.signalListeners) listener(message);
      }
    }
  }

  async call(call: Call): Promise<unknown[]> {
    const socket = this.socket;
    if (!socket) throw new Error("the D-Bus connection is closed");
    const serial = ++this.serial;
    const fields: [number, Variant][] = [
      [FIELD.path, variant("o", call.path)],
      [FIELD.interface, variant("s", call.interface)],
      [FIELD.member, variant("s", call.member)],
      [FIELD.destination, variant("s", call.destination)],
    ];
    const reply = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replies.delete(serial);
        reject(new Error(`${call.interface}.${call.member} didn't answer`));
      }, CALL_DEADLINE_MS);
      this.replies.set(serial, { resolve, reject, timer });
    });
    socket.write(encode({ type: METHOD_CALL, serial, fields, signature: call.signature ?? "", body: call.body ?? [] }));
    return (await reply).body;
  }

  onSignal(listener: (message: Message) => void): () => void {
    this.signalListeners.add(listener);
    return () => void this.signalListeners.delete(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  async addMatch(rule: string): Promise<void> {
    await this.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "AddMatch", signature: "s", body: [rule] });
  }

  async getProperty(destination: string, path: string, iface: string, name: string): Promise<unknown> {
    const [value] = await this.call({ destination, path, interface: "org.freedesktop.DBus.Properties", member: "Get", signature: "ss", body: [iface, name] });
    return (value as Variant | undefined)?.value;
  }

  async setProperty(destination: string, path: string, iface: string, name: string, value: Variant): Promise<void> {
    await this.call({ destination, path, interface: "org.freedesktop.DBus.Properties", member: "Set", signature: "ssv", body: [iface, name, value] });
  }

  close(): void {
    this.socket?.end();
    this.closed();
  }
}
