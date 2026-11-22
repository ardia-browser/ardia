const OWN_FRAME = /^(Ardia|Chromium Framework|hermes)/;

export function topOwnFrames(framesJson: string, limit = 3): string[] {
  try {
    const frames = JSON.parse(framesJson) as { function?: unknown; in_app?: unknown }[];
    return frames
      .slice()
      .reverse()
      .map((f) => (typeof f.function === "string" ? f.function : ""))
      .filter((f) => OWN_FRAME.test(f))
      .slice(0, limit);
  } catch {
    return [];
  }
}
