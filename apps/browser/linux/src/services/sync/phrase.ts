import { createHash, randomBytes } from "node:crypto";
import { KEY_BYTES } from "./crypto.ts";
import { ENGLISH_WORDS } from "./wordlist.ts";

export const WORD_COUNT = 24;

export type PhraseProblem = { error: "wordCount"; count: number } | { error: "unknownWord"; word: string } | { error: "checksum" };

const lookup = new Map(ENGLISH_WORDS.map((word, i) => [word, i]));
const prefixes = new Map(ENGLISH_WORDS.map((word, i) => [word.slice(0, 4), i]));

const checksumByte = (entropy: Uint8Array) => createHash("sha256").update(entropy).digest()[0]!;

export const newEntropy = (): Buffer => randomBytes(KEY_BYTES);

export function wordsFor(entropy: Uint8Array): string[] {
  if (entropy.length !== KEY_BYTES) throw new Error("a sync key is 32 bytes");
  const bytes = [...entropy, checksumByte(entropy)];
  const bit = (at: number) => (bytes[at >> 3]! >> (7 - (at & 7))) & 1;
  const words: string[] = [];
  for (let word = 0; word < WORD_COUNT; word++) {
    let index = 0;
    for (let at = word * 11; at < word * 11 + 11; at++) index = (index << 1) | bit(at);
    words.push(ENGLISH_WORDS[index]!);
  }
  return words;
}

export const phraseTokens = (text: string): string[] => text.toLowerCase().match(/\p{Ll}+/gu) ?? [];

function indexOf(token: string): number | undefined {
  const exact = lookup.get(token);
  if (exact !== undefined) return exact;
  if ([...token].length < 4) return undefined;
  const candidate = prefixes.get(token.slice(0, 4));
  return candidate !== undefined && ENGLISH_WORDS[candidate]!.startsWith(token) ? candidate : undefined;
}

export function entropyFrom(text: string): Buffer | PhraseProblem {
  const tokens = phraseTokens(text);
  if (tokens.length !== WORD_COUNT) return { error: "wordCount", count: tokens.length };
  const bits: number[] = [];
  for (const token of tokens) {
    const index = indexOf(token);
    if (index === undefined) return { error: "unknownWord", word: token };
    for (let shift = 10; shift >= 0; shift--) bits.push((index >> shift) & 1);
  }
  const entropy = Buffer.alloc(KEY_BYTES);
  for (let i = 0; i < KEY_BYTES * 8; i++) entropy[i >> 3] = entropy[i >> 3]! | (bits[i]! << (7 - (i & 7)));
  let checksum = 0;
  for (let i = KEY_BYTES * 8; i < bits.length; i++) checksum = (checksum << 1) | bits[i]!;
  if (checksumByte(entropy) !== checksum) return { error: "checksum" };
  return entropy;
}
