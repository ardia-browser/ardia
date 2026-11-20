import { uuid } from "expo-modules-core";

export const secureRandomHex = (length: number): string => {
  let out = "";
  while (out.length < length) out += uuid.v4().replace(/-/g, "");
  return out.slice(0, length);
};

const VERSION_NIBBLE = 12;
const VARIANT_NIBBLE = 16;

function uuidRandomBytes(): number[] {
  const hex = uuid.v4().replace(/-/g, "");
  const random = hex.slice(0, VERSION_NIBBLE) + hex.slice(VERSION_NIBBLE + 1, VARIANT_NIBBLE) + hex.slice(VARIANT_NIBBLE + 1);
  const bytes: number[] = [];
  for (let i = 0; i + 1 < random.length; i += 2) bytes.push(parseInt(random.slice(i, i + 2), 16));
  return bytes;
}

export function secureRandomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  const source = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (typeof source?.getRandomValues === "function") return source.getRandomValues(bytes);
  let filled = 0;
  while (filled < count) for (const byte of uuidRandomBytes()) if (filled < count) bytes[filled++] = byte;
  return bytes;
}
