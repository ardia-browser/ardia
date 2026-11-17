let writes = 0;
let cosmeticWrites = 0;
let characters = 0;

export function noteSessionWrite(length: number, cosmeticOnly: boolean) {
  writes++;
  if (cosmeticOnly) cosmeticWrites++;
  characters += length;
}

export function takeSessionWrites() {
  const taken = { session_writes: writes, session_cosmetic_writes: cosmeticWrites, session_kb_written: Math.round(characters / 1024) };
  writes = 0;
  cosmeticWrites = 0;
  characters = 0;
  return taken;
}
