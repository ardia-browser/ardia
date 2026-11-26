import { toBase64, type SubtleLike } from "@ardia/plugin-sdk/registry";
import { nativeVerifySignature } from "./plugins";

const ED25519_SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

type NativeKey = { raw: Uint8Array };

function rawKey(format: string, data: Uint8Array): Uint8Array {
  if (format === "raw" && data.length === 32) return data;
  if (format === "spki" && data.length === 44 && ED25519_SPKI_PREFIX.every((byte, i) => data[i] === byte)) return data.slice(12);
  throw new Error("That isn't an Ed25519 public key");
}

const nativeSubtle: SubtleLike = {
  importKey: async (format, keyData) => ({ raw: rawKey(format, keyData) }) satisfies NativeKey,
  sign: async () => {
    throw new Error("Ardia only verifies registry signatures");
  },
  verify: async (_algorithm, key, signature, data) => nativeVerifySignature(toBase64((key as NativeKey).raw), toBase64(signature), toBase64(data)),
};

type WithSubtle = { crypto?: { subtle?: SubtleLike } };

export function pluginSubtle(): SubtleLike {
  return (globalThis as WithSubtle).crypto?.subtle ?? nativeSubtle;
}
