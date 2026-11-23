const ENGINE_MATCHES = new Set(["exact", "nearest", "local", "unknown"]);

export const engineMatchProperties = (engineMatch: unknown): { engine_match?: string } =>
  typeof engineMatch === "string" && ENGINE_MATCHES.has(engineMatch) ? { engine_match: engineMatch } : {};
