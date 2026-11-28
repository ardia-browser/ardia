export const SHELL_MIGRATION_ATTEMPT_DOC = "rnw-migration-attempt.json";
export const SHELL_MIGRATION_REPORTED_DOC = "rnw-migration-reported.json";
export const CHROMIUM_MIGRATION_ATTEMPT_DOC = "rnw-chromium-migration-attempt.json";
export const CHROMIUM_MIGRATION_REPORTED_DOC = "rnw-chromium-migration-reported.json";

const OUTCOMES = new Set(["migrated", "migrated_with_skips", "already_migrated", "nothing_to_migrate", "busy", "refused", "failed"]);

export type ShellMigrationStep = {
  name: "documents" | "chromium";
  attemptDoc: string;
  reportedDoc: string;
  stages: ReadonlySet<string>;
  counts: readonly string[];
};

export const DOCUMENTS_STEP: ShellMigrationStep = {
  name: "documents",
  attemptDoc: SHELL_MIGRATION_ATTEMPT_DOC,
  reportedDoc: SHELL_MIGRATION_REPORTED_DOC,
  stages: new Set(["layout", "lock", "documents", "config", "sync_keys", "credentials", "report", "marker"]),
  counts: [
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
  ],
};

export const CHROMIUM_STEP: ShellMigrationStep = {
  name: "chromium",
  attemptDoc: CHROMIUM_MIGRATION_ATTEMPT_DOC,
  reportedDoc: CHROMIUM_MIGRATION_REPORTED_DOC,
  stages: new Set(["layout", "lock", "in_use", "local_state", "scan", "space", "staging", "backup", "swap", "progress", "report", "marker"]),
  counts: [
    "profiles",
    "profiles_replaced",
    "webui_profiles_backed_up",
    "webui_profiles_left",
    "files",
    "megabytes",
    "skipped_links",
    "skipped_invalid",
    "skipped_clash",
    "key_carried",
    "key_shared",
    "key_missing",
    "key_unreadable",
    "local_state_kept",
    "local_state_malformed",
    "staging_cleared",
    "swap_rolled_back",
    "partials_swept",
  ],
};

export const SHELL_MIGRATION_STEPS = [DOCUMENTS_STEP, CHROMIUM_STEP] as const;

const COUNT_CAP = 1_000_000;
const DURATION_CAP_MS = 3_600_000;
const RUN = /^[0-9a-f]{32}$/;

export type ShellMigrationProperties = {
  step: ShellMigrationStep["name"];
  outcome: string;
  failed_stage?: string;
  prior_failed_stage?: string;
  attempt: number;
  duration_ms: number;
} & { [count: string]: number | string };
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

export function shellMigrationReport(text: string | null, step: ShellMigrationStep = DOCUMENTS_STEP): ShellMigrationReport | null {
  const report = parsed(text);
  if (!isObject(report) || report.version !== 1) return null;
  if ((report.step ?? "documents") !== step.name) return null;
  const { run, outcome, failed_stage: stage, prior_failed_stage: priorStage } = report;
  if (typeof run !== "string" || !RUN.test(run) || typeof outcome !== "string" || !OUTCOMES.has(outcome)) return null;
  const counts = isObject(report.counts) ? report.counts : {};
  const properties = {
    step: step.name,
    outcome,
    ...(typeof stage === "string" && step.stages.has(stage) && { failed_stage: stage }),
    ...(typeof priorStage === "string" && step.stages.has(priorStage) && { prior_failed_stage: priorStage }),
    attempt: Math.max(1, count(report.attempt, COUNT_CAP)),
    duration_ms: count(report.duration_ms, DURATION_CAP_MS),
    ...Object.fromEntries(step.counts.map((name) => [name, count(counts[name], COUNT_CAP)])),
  } as ShellMigrationProperties;
  return { run, properties };
}

const reportedRun = (text: string | null) => {
  const reported = parsed(text);
  return isObject(reported) && typeof reported.run === "string" ? reported.run : null;
};

export const SHELL_MIGRATION_DOCUMENTS = SHELL_MIGRATION_STEPS.flatMap((step) => [step.attemptDoc, step.reportedDoc]);

export function pendingShellMigration(read: (name: string) => string | null, step: ShellMigrationStep = DOCUMENTS_STEP): ShellMigrationReport | null {
  const report = shellMigrationReport(read(step.attemptDoc), step);
  return report && reportedRun(read(step.reportedDoc)) !== report.run ? report : null;
}

export type ShellMigrationReporting = {
  read(name: string): string | null;
  save(name: string, contents: string): Promise<void>;
  sharing(): boolean;
  send(properties: ShellMigrationProperties): boolean;
  persisted(): Promise<boolean>;
};

export type ShellMigrationOutcome = "none" | "held" | "dropped" | "unpersisted" | "revoked" | "reported";

export async function reportShellMigration(reporting: ShellMigrationReporting, step: ShellMigrationStep = DOCUMENTS_STEP): Promise<ShellMigrationOutcome> {
  const report = pendingShellMigration(reporting.read, step);
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
  await reporting.save(step.reportedDoc, JSON.stringify({ run: report.run }));
  return "reported";
}

export async function reportShellMigrations(reporting: ShellMigrationReporting): Promise<ShellMigrationOutcome> {
  let first: ShellMigrationOutcome = "none";
  let failure: { error: unknown } | null = null;
  for (const step of SHELL_MIGRATION_STEPS) {
    try {
      const outcome = await reportShellMigration(reporting, step);
      if (first === "none") first = outcome;
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
  return first;
}
