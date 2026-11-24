import { isSecret, noteSecretEscape } from "@ardia/core";
import { queueLog, type ConsentToken } from "./client";
import { errorCode, errorMessage, errorType, scrubText } from "./sanitize";

const MAX_DISTINCT = 40;
const seen = new Set<string>();

export { errorFor, logConsent, warnFor } from "./consoleConsent";

export function recordLog(level: "warn" | "error", args: unknown[], consent: ConsentToken | null) {
  for (const arg of args) if (isSecret(arg)) noteSecretEscape("log", arg);
  const first = args[0];
  if (typeof first !== "string") return;
  const message = scrubText(first, 160);
  if (!message) return;
  const error = args.slice(1).find((a) => a instanceof Error);
  const reason = error ? errorMessage(error) : "";
  const key = `${message}\n${reason}`;
  if (seen.has(key) || seen.size >= MAX_DISTINCT) return;
  seen.add(key);
  const attributes: Record<string, string> = { error_type: error ? errorType(error) : "none" };
  if (reason) attributes.error_message = reason;
  const code = error ? errorCode(error) : null;
  if (code) attributes.error_code = code;
  queueLog(level, message, attributes, consent);
}
