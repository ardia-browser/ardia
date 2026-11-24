import { DAILY_DOC } from "../../browser/src/state/telemetry/daily";
import { SHELL_MIGRATION_DOCUMENTS } from "../../browser/src/state/telemetry/shellMigration";

export const TELEMETRY_STATE_DOC = "telemetry.json";

export const TELEMETRY_DOCUMENTS = [TELEMETRY_STATE_DOC, "telemetry-queue.json", DAILY_DOC, ...SHELL_MIGRATION_DOCUMENTS];
