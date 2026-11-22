import type { ConsentToken } from "../telemetry/choice";

const scanned = new Set<(consent: ConsentToken | null) => void>();

export function afterPluginScan(listener: (consent: ConsentToken | null) => void): () => void {
  scanned.add(listener);
  return () => void scanned.delete(listener);
}

export function pluginsScanned(consent: ConsentToken | null) {
  for (const listener of [...scanned]) listener(consent);
}
