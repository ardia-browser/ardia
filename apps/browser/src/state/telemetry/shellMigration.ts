export const SHELL_MIGRATION_ATTEMPT_DOC = "rnw-migration-attempt.json";
export const SHELL_MIGRATION_REPORTED_DOC = "rnw-migration-reported.json";

const OUTCOMES = new Set(["migrated", "migrated_with_skips", "already_migrated", "nothing_to_migrate", "busy", "refused", "failed"]);
const STAGES = new Set(["layout", "lock", "documents", "config", "sync_keys", "credentials", "report", "marker"]);
const COUNTS = [
  "documents",
  "placement",
  "config_files",
  "sync_keys",
  "credentials",
  "unchanged",
  "kept_aside",
  "skipped_links",
  "skipped_invalid",
  "skipped_too_large",
  "skipped_case_clash",
  "sync_keys_unreadable",
  "credentials_incomplete",
  "credential_chunks_orphaned",
  "partials_swept",
] as const;
const COUNT_CAP = 1_000_000;
const DURATION_CAP_MS = 3_600_000;
const RUN = /^[0-9a-f]{32}$/;

type CountName = (typeof COUNTS)[number];
export type ShellMigrationProperties = { outcome: string; failed_stage?: string; prior_failed_stage?: string; attempt: number; duration_ms: number } & { [K in CountName]: number };
export type ShellMigrationReport = { run: string; properties: ShellMigrationProperties };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown, cap: number) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : 0);

function parsed(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function shellMigrationReport(text: string | null): ShellMigrationReport | null {
  const report = parsed(text);
  if (!isObject(report) || report.version !== 1) return null;
  const { run, outcome, failed_stage: stage, prior_failed_stage: priorStage } = report;
  if (typeof run !== "string" || !RUN.test(run) || typeof outcome !== "string" || !OUTCOMES.has(outcome)) return null;
  const counts = isObject(report.counts) ? report.counts : {};
  const properties = {
    outcome,
    ...(typeof stage === "string" && STAGES.has(stage) && { failed_stage: stage }),
    ...(typeof priorStage === "string" && STAGES.has(priorStage) && { prior_failed_stage: priorStage }),
    attempt: Math.max(1, count(report.attempt, COUNT_CAP)),
    duration_ms: count(report.duration_ms, DURATION_CAP_MS),
    ...Object.fromEntries(COUNTS.map((name) => [name, count(counts[name], COUNT_CAP)])),
  } as ShellMigrationProperties;
  return { run, properties };
}

const reportedRun = (text: string | null) => {
  const reported = parsed(text);
  return isObject(reported) && typeof reported.run === "string" ? reported.run : null;
};

export const SHELL_MIGRATION_DOCUMENTS = [SHELL_MIGRATION_ATTEMPT_DOC, SHELL_MIGRATION_REPORTED_DOC] as const;

export function pendingShellMigration(read: (name: string) => string | null): ShellMigrationReport | null {
  const report = shellMigrationReport(read(SHELL_MIGRATION_ATTEMPT_DOC));
  return report && reportedRun(read(SHELL_MIGRATION_REPORTED_DOC)) !== report.run ? report : null;
}

export type ShellMigrationReporting = {
  read(name: string): string | null;
  save(name: string, contents: string): Promise<void>;
  sharing(): boolean;
  send(properties: ShellMigrationProperties): boolean;
  persisted(): Promise<boolean>;
};

export async function reportShellMigration(reporting: ShellMigrationReporting): Promise<"none" | "held" | "dropped" | "unpersisted" | "revoked" | "reported"> {
  const report = pendingShellMigration(reporting.read);
  if (!report) return "none";
  if (!reporting.sharing()) return "held";
  let accepted = false;
  try {
    accepted = reporting.send(report.properties) === true;
  } catch {
    accepted = false;
  }
  if (!accepted) return "dropped";
  if ((await reporting.persisted().catch(() => false)) !== true) return "unpersisted";
  if (!reporting.sharing()) return "revoked";
  await reporting.save(SHELL_MIGRATION_REPORTED_DOC, JSON.stringify({ run: report.run }));
  return "reported";
}
