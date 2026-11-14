import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FILE_PADDING = 1024;
const PASSWORD_PADDING = 32;
const PASSWORD_VERSION = 1;
const MAGIC = Buffer.from("NNS1", "utf8");
const SALT = Buffer.from("netnyahoo-sync/v1", "utf8");
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export class SealFailure extends Error {
  readonly reason: "format" | "authentication";

  constructor(reason: "format" | "authentication") {
    super(`a sealed sync value didn't open (${reason})`);
    this.reason = reason;
  }
}

export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export const isTag = (name: string): boolean => name.length === 26 && [...name].every((ch) => BASE32_ALPHABET.includes(ch));

export const newFileId = (): string => base32(randomBytes(16));

const bigEndian32 = (n: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(n);
  return out;
};

function padded(payload: Buffer, block: number): Buffer {
  const length = 4 + payload.length;
  const plain = Buffer.alloc(length + ((block - (length % block)) % block));
  plain.writeUInt32BE(payload.length, 0);
  payload.copy(plain, 4);
  return plain;
}

function unpadded(plain: Buffer): Buffer {
  if (plain.length < 4) throw new SealFailure("format");
  const length = plain.readUInt32BE(0);
  if (length > plain.length - 4) throw new SealFailure("format");
  return plain.subarray(4, 4 + length);
}

function sealBox(key: Buffer, nonce: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function openBox(key: Buffer, box: Buffer, aad: Buffer): Buffer {
  if (box.length < NONCE_BYTES + TAG_BYTES) throw new SealFailure("format");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, box.subarray(0, NONCE_BYTES));
    decipher.setAAD(aad);
    decipher.setAuthTag(box.subarray(box.length - TAG_BYTES));
    return Buffer.concat([decipher.update(box.subarray(NONCE_BYTES, box.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new SealFailure("authentication");
  }
}

const derive = (entropy: Buffer, info: string) => Buffer.from(hkdfSync("sha256", entropy, SALT, Buffer.from(info, "utf8"), 32));

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export class SyncKeys {
  readonly chainTag: string;
  private readonly fileKey: Buffer;
  private readonly nameKey: Buffer;
  private readonly passwordKey: Buffer;
  private readonly passwordNonceKey: Buffer;

  constructor(entropy: Uint8Array) {
    if (entropy.length !== KEY_BYTES) throw new Error("a sync key is 32 bytes");
    const ikm = Buffer.from(entropy);
    this.fileKey = derive(ikm, "file-key");
    this.nameKey = derive(ikm, "name-key");
    this.passwordKey = derive(ikm, "password-key");
    this.passwordNonceKey = derive(ikm, "password-nonce-key");
    this.chainTag = this.tag("chain");
  }

  tag(label: string): string {
    return base32(createHmac("sha256", this.nameKey).update(label, "utf8").digest().subarray(0, 16));
  }

  scopeTag(scope: string): string {
    return this.tag(`scope/${scope}`);
  }

  private fileAad(scopeTag: string, fileId: string): Buffer {
    return Buffer.concat([MAGIC, Buffer.from(`${this.chainTag}/${scopeTag}/${fileId}`, "utf8")]);
  }

  seal(payload: Uint8Array, scopeTag: string, fileId: string): Buffer {
    const box = sealBox(this.fileKey, randomBytes(NONCE_BYTES), padded(Buffer.from(payload), FILE_PADDING), this.fileAad(scopeTag, fileId));
    return Buffer.concat([MAGIC, box]);
  }

  open(file: Uint8Array, scopeTag: string, fileId: string): Buffer {
    const data = Buffer.from(file);
    if (data.length < MAGIC.length + NONCE_BYTES + TAG_BYTES + 4 || !data.subarray(0, MAGIC.length).equals(MAGIC)) throw new SealFailure("format");
    return unpadded(openBox(this.fileKey, data.subarray(MAGIC.length), this.fileAad(scopeTag, fileId)));
  }

  static passwordAad(origin: string, username: string): Buffer {
    const originBytes = Buffer.from(origin, "utf8");
    return Buffer.concat([MAGIC, Buffer.from("password/", "utf8"), bigEndian32(originBytes.length), originBytes, Buffer.from(username, "utf8")]);
  }

  sealPassword(password: string, origin: string, username: string): string {
    const plain = padded(Buffer.from(password, "utf8"), PASSWORD_PADDING);
    const aad = SyncKeys.passwordAad(origin, username);
    const nonce = createHmac("sha256", this.passwordNonceKey).update(bigEndian32(aad.length)).update(aad).update(plain).digest().subarray(0, NONCE_BYTES);
    return Buffer.concat([Buffer.from([PASSWORD_VERSION]), sealBox(this.passwordKey, nonce, plain, aad)]).toString("base64");
  }

  openPassword(sealed: string, origin: string, username: string): string {
    const data = Buffer.from(sealed, "base64");
    if (data.length < 1 + NONCE_BYTES + TAG_BYTES + 4 || data[0] !== PASSWORD_VERSION || data.toString("base64") !== sealed.replace(/\s/g, "")) throw new SealFailure("format");
    const password = unpadded(openBox(this.passwordKey, data.subarray(1), SyncKeys.passwordAad(origin, username)));
    try {
      return strictUtf8.decode(password);
    } catch {
      throw new SealFailure("format");
    }
  }
}
