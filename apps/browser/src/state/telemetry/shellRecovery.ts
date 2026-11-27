import { readDocument } from "../../platform/documents";

export const SHELL_RECOVERY_DOC = "shell-recovery-previous.json";

const MAX_SHELL_RECOVERY_COUNT = 1000;

type ShellRecoveryProperties = {
  prev_shell_recovery_attempts?: number;
  prev_shell_recovery_recovered?: number;
  prev_shell_recovery_exhausted?: number;
};

export function shellRecoveryProperties(read: (name: string) => string | null = readDocument): ShellRecoveryProperties {
  let saved: unknown;
  try {
    const raw = read(SHELL_RECOVERY_DOC);
    if (!raw) return {};
    saved = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  const facts = saved as Record<string, unknown>;
  const recoveries = (value: unknown) => {
    const n = typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
    return n === undefined ? undefined : Math.min(n, MAX_SHELL_RECOVERY_COUNT);
  };
  const attempts = recoveries(facts.attempts);
  const recovered = recoveries(facts.recovered);
  const exhausted = recoveries(facts.exhausted);
  if (!attempts && !recovered && !exhausted) return {};
  const properties: ShellRecoveryProperties = {};
  if (attempts !== undefined) properties.prev_shell_recovery_attempts = attempts;
  if (recovered !== undefined) properties.prev_shell_recovery_recovered = recovered;
  if (exhausted !== undefined) properties.prev_shell_recovery_exhausted = exhausted;
  return properties;
}
