import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

export type AwarenessClient = { id: number; clock: number; removed: boolean; state: string };

export function awarenessClients(update: Uint8Array): AwarenessClient[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  if (count > 1000) throw new Error("Too many awareness clients in one update.");
  const out: AwarenessClient[] = [];
  for (let i = 0; i < count; i++) {
    const id = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const state = decoding.readVarString(decoder);
    out.push({ id, clock, removed: state === "null", state });
  }
  return out;
}

export function awarenessRemoval(clients: { id: number; clock: number }[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, clients.length);
  for (const c of clients) {
    encoding.writeVarUint(encoder, c.id);
    encoding.writeVarUint(encoder, c.clock + 1);
    encoding.writeVarString(encoder, "null");
  }
  return encoding.toUint8Array(encoder);
}

export function encodeAwareness(clients: { id: number; clock: number; state: string }[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, clients.length);
  for (const c of clients) {
    encoding.writeVarUint(encoder, c.id);
    encoding.writeVarUint(encoder, c.clock);
    encoding.writeVarString(encoder, c.state);
  }
  return encoding.toUint8Array(encoder);
}
