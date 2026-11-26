#!/usr/bin/env node
// A stand-in for Apple's Passwords helper (PasswordManagerBrowserExtensionHelper), for hidden-instance checks only.
// It speaks the helper's framing (little-endian length, then JSON), the SRP-6a Pairing (RFC 5054 3072-bit group,
// SHA-256, the six-digit code as the password) and AES-128-GCM sealed requests, as Yab's client reads them
// (Sources/Fast/ApplePasswords.swift, Apache-2.0). Fixture values only.
//
//   fake-helper.mjs <state dir> <origin>
//
//   <state dir>/fixtures.json  { code, logins: [{ user, password, sites: [host or http://host] }], codes: [{ domain, username, code }] }
//   <state dir>/mode.json      re-read on every message: { killedAtLaunch, wrongCode, status: { "<cmd>": n }, endPairing: n }
//                              (endPairing: bump the number and the helper ends the Pairing with a cmd 9 push)
//   <state dir>/started        one line per launch (pid and time): the marker that the helper ran
//   <state dir>/requests.jsonl one line per message: { cmd, qid?, url?, host? }, never a code or password
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [stateDir] = process.argv.slice(2);
if (!stateDir || stateDir === "--help" || stateDir === "-h") {
  const lines = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
  process.stderr.write(`${lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")}\n`);
  process.exit(stateDir ? 0 : 64);
}

const file = (name) => path.join(stateDir, name);
const readJson = (name, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch {
    return fallback;
  }
};
const mode = () => readJson("mode.json", {});
const fixtures = () => readJson("fixtures.json", { code: "123456", logins: [], codes: [] });

fs.appendFileSync(file("started"), `${process.pid} ${new Date().toISOString()}\n`);
if (mode().killedAtLaunch) process.kill(process.pid, "SIGKILL");

const N = BigInt(
  "0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B30" +
    "2B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE6492866" +
    "51ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4A" +
    "BC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956A" +
    "E515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7AB" +
    "F5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988" +
    "C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
);
const g = 5n;
const LENGTH = 384;

const modPow = (base, exponent, modulus) => {
  let result = 1n;
  let b = base % modulus;
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
  }
  return result;
};
const number = (bytes) => (bytes.length ? BigInt(`0x${Buffer.from(bytes).toString("hex")}`) : 0n);
const raw = (n) => {
  const hex = n.toString(16);
  return n === 0n ? Buffer.alloc(0) : Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
};
const pad = (n) => Buffer.concat([Buffer.alloc(Math.max(0, LENGTH - raw(n).length)), raw(n)]);
const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const enc = (bytes) => Buffer.from(bytes).toString("base64");
const dec = (text) => Buffer.from(text, "base64");
const pake = (object) => enc(Buffer.from(JSON.stringify(object)));
const unpake = (text) => JSON.parse(dec(text).toString("utf8"));
const jsonOf = (value) => (typeof value === "string" ? JSON.parse(value) : value);

let pending = null;
let session = null;
let endedAt = mode().endPairing ?? 0;

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([length, body]));
}

const logRequest = (entry) => fs.appendFileSync(file("requests.jsonl"), `${JSON.stringify(entry)}\n`);

function roundZero(tid, A) {
  const salt = randomBytes(16);
  const b = number(randomBytes(32));
  const x = number(sha(salt, sha(Buffer.from(`${tid}:${fixtures().code}`))));
  const v = modPow(g, x, N);
  const k = number(sha(pad(N), pad(g)));
  const B = (k * v + modPow(g, b, N)) % N;
  const u = number(sha(pad(A), pad(B)));
  const K = sha(raw(modPow((A * modPow(v, u, N)) % N, b, N)));
  const hn = sha(raw(N));
  const hg = sha(pad(g));
  const M = sha(Buffer.from(hn.map((byte, i) => byte ^ hg[i])), sha(Buffer.from(tid)), salt, raw(A), raw(B), K);
  pending = { tid, M, hamk: sha(raw(A), M, K), key: K.subarray(0, 16) };
  return { TID: tid, MSG: 1, PROTO: 1, s: enc(salt), B: enc(raw(B)) };
}

function roundTwo(tid, M) {
  const waiting = pending;
  pending = null;
  if (!waiting || waiting.tid !== tid || mode().wrongCode || !dec(M).equals(waiting.M)) return { TID: tid, MSG: 3, ErrCode: 1 };
  session = { tid, key: waiting.key };
  return { TID: tid, MSG: 3, ErrCode: 0, HAMK: enc(waiting.hamk) };
}

function pairing(message) {
  const payload = JSON.parse(message.msg);
  const step = unpake(payload.PAKE);
  logRequest({ cmd: 2, round: step.MSG });
  const reply = step.MSG === 0 ? roundZero(step.TID, number(dec(step.A))) : roundTwo(step.TID, step.M);
  send({ cmd: 2, payload: { QID: payload.QID, PAKE: pake(reply) } });
}

function open(text) {
  const envelope = jsonOf(text);
  if (!session || envelope.TID !== session.tid) return null;
  const sdata = dec(envelope.SDATA);
  const decipher = createDecipheriv("aes-128-gcm", session.key, sdata.subarray(sdata.length - 16));
  decipher.setAuthTag(sdata.subarray(sdata.length - 32, sdata.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(sdata.subarray(0, sdata.length - 32)), decipher.final()]).toString("utf8"));
}

function seal(object) {
  const nonce = randomBytes(16);
  const cipher = createCipheriv("aes-128-gcm", session.key, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(object))), cipher.final()]);
  return { TID: session.tid, SDATA: enc(Buffer.concat([nonce, ciphertext, cipher.getAuthTag()])) };
}

const bare = (site) => site.replace(/^https?:\/\//, "");
const sameSite = (sites, host) => sites.map(bare).some((site) => site === host || host.endsWith(`.${site}`) || site.endsWith(`.${host}`));

function answer(cmd, body) {
  const forced = mode().status?.[String(cmd)];
  if (forced !== undefined) return { STATUS: forced };
  const { logins, codes } = fixtures();
  const host = body.URL || body.NURL || "";
  if (cmd === 4) return { STATUS: 0, Entries: logins.filter((l) => sameSite(l.sites, host)).map((l) => ({ USR: l.user, sites: l.sites, PWD: "Not Included" })) };
  if (cmd === 5) {
    const login = logins.find((l) => l.user === body.USR && sameSite(l.sites, host));
    return login ? { STATUS: 0, Entries: [{ USR: login.user, sites: login.sites, PWD: login.password }] } : { STATUS: 3, Entries: [] };
  }
  if (cmd === 6) {
    const kept = logins.find((l) => l.user === body.NUSR && sameSite(l.sites, host));
    if (kept?.password === body.NPWD) return { STATUS: 7 };
    const rest = logins.filter((l) => l !== kept);
    fs.writeFileSync(file("fixtures.json"), JSON.stringify({ ...fixtures(), logins: [...rest, { user: body.NUSR, password: body.NPWD, sites: [host] }] }, null, 2));
    return { STATUS: 0 };
  }
  if (cmd === 16 || cmd === 17) {
    const page = (body.frameURLs ?? [])[0] ?? "";
    const pageHost = URL.canParse(page) ? new URL(page).hostname : "";
    const found = codes.filter((c) => sameSite([c.domain], pageHost) && (cmd === 16 || c.username === body.username));
    return { STATUS: 0, Entries: found.map((c) => ({ source: "totp", domain: c.domain, username: c.username, code: c.code })) };
  }
  return { STATUS: 1 };
}

function sealed(message) {
  const payload = jsonOf(message.payload);
  const body = open(payload?.SMSG);
  logRequest({ cmd: message.cmd, qid: payload?.QID, url: message.url, host: body?.URL ?? body?.NURL });
  if (!body) return send({ cmd: message.cmd, payload: {} });
  send({ cmd: message.cmd, payload: { SMSG: seal(answer(message.cmd, body)) } });
}

function handle(message) {
  const cmd = message?.cmd;
  if (cmd === 14) return logRequest({ cmd }), send({ cmd: 14, capabilities: { shouldUseBase64: true, canFillOneTimeCodes: true } });
  if (cmd === 2) return pairing(message);
  if (cmd === 19) return logRequest({ cmd }), void (pending = null);
  if (typeof cmd === "number") return sealed(message);
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
    const length = buffer.readUInt32LE(0);
    const body = buffer.subarray(4, 4 + length);
    buffer = buffer.subarray(4 + length);
    try {
      handle(JSON.parse(body.toString("utf8")));
    } catch (error) {
      logRequest({ error: String(error?.message ?? error).slice(0, 200) });
    }
  }
});
process.stdin.on("end", () => process.exit(0));

setInterval(() => {
  const asked = mode().endPairing ?? 0;
  if (asked === endedAt) return;
  endedAt = asked;
  session = null;
  pending = null;
  send({ cmd: 9 });
}, 200);
