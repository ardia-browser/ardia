import { create } from "zustand";
import { ardiaError, asSecret } from "@ardia/core";
import {
  credentialExchangeStatus,
  onCredentialExchange,
  passwordBatchSaver,
  requestCredentialExchange,
  takeExchangedCredentials,
  type ExchangedCredentials,
} from "../../platform/credentialExchange";
import { savePassword } from "../../platform/passwords";
import { passwordFailure } from "../../lib/fallback";
import { saveVerificationSecret } from "../site/vaultCodes";
import { originOfLogin } from "../site/savedPasswords";
import { useBrowser } from "../browser/store";
import { engineProfile, plural } from "../browser/model";
import { openImport } from "../settings/settingsWindows";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteCredentialExchangeFailure, noteCredentialExchangeImport } from "../telemetry/credentialExchangeCounts";
import { emptyCounts } from "./apply";
import { enterImportAt, finishImport, importNow, importSignal, importWindowOpen, NO_EXTENSIONS, patchImport, whenImportWindowOpen, type ImportStep } from "./flow";

export type ExchangeResult = {
  exporter: string;
  saved: number;
  existing: number;
  failed: number;
  codes: number;
  codesFailed: number;
  passkeys: number;
  skipped: number;
};

const PARALLEL_SAVES = 8;
const BATCH_ROWS = 500;

export const useLastExchange = create<{ result: ExchangeResult | null }>()(() => ({ result: null }));

export const passwordManagerImportShown = () => credentialExchangeStatus().receivable;

async function inParallel<T>(items: T[], limit: number, each: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await each(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

type Login = { origin: string; username: string; password: string };

async function savePasswords(profile: string, logins: Login[]) {
  const counts = { saved: 0, existing: 0, failed: 0, batched: false };
  let batch = passwordBatchSaver();
  for (let at = 0; batch && at < logins.length; at += BATCH_ROWS) {
    const rows = logins.slice(at, at + BATCH_ROWS);
    const answer = await batch(profile, rows).catch(() => null);
    if (!answer) {
      batch = null;
      logins = logins.slice(at);
      break;
    }
    counts.batched = true;
    counts.saved += answer.saved;
    counts.existing += answer.existing;
    counts.failed += answer.failed;
  }
  if (batch) return counts;
  await inParallel(logins, PARALLEL_SAVES, async (login) => {
    try {
      if (await savePassword(profile, login.origin, login.username, asSecret("password", login.password))) counts.saved++;
      else counts.failed++;
    } catch (error) {
      if (passwordFailure(error) === "refused-or-already-saved") counts.existing++;
      else counts.failed++;
    }
  });
  return counts;
}

async function saveCodes(profile: string, codes: { origin: string; username: string; otpAuth: string }[], consent: ConsentToken | null) {
  const counts = { saved: 0, failed: 0 };
  await inParallel(codes, PARALLEL_SAVES, async (code) => {
    const saved = await saveVerificationSecret(profile, code.origin, code.username, code.otpAuth, consent).catch(() => false);
    if (saved) counts.saved++;
    else counts.failed++;
  });
  return counts;
}

function withOrigins<T extends { url: string; username: string }>(rows: T[]) {
  const seen = new Set<string>();
  const kept: (T & { origin: string })[] = [];
  let noSite = 0;
  for (const row of rows) {
    const origin = originOfLogin(row.url).toLowerCase();
    if (!origin) {
      noSite++;
      continue;
    }
    const key = `${origin}\n${row.username}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ ...row, origin });
  }
  return { kept, noSite };
}

export async function saveExchangedCredentials(profile: string, data: ExchangedCredentials, consent: ConsentToken | null): Promise<ExchangeResult> {
  const started = Date.now();
  const logins = withOrigins(data.logins);
  const codes = withOrigins(data.codes);
  const [passwords, saved] = await Promise.all([
    savePasswords(
      profile,
      logins.kept.map(({ origin, username, password }) => ({ origin, username, password })),
    ),
    saveCodes(profile, codes.kept, consent),
  ]);
  const noSite = data.noSite + logins.noSite + codes.noSite;
  noteCredentialExchangeImport(
    {
      kind: data.source,
      passwords: passwords.saved,
      existing: passwords.existing,
      failed: passwords.failed,
      codes: saved.saved,
      codes_failed: saved.failed,
      passkeys_left: data.passkeys,
      no_site: noSite,
      unsupported: data.unsupported,
      batched: passwords.batched,
      receive_ms: data.receiveMs,
      parse_ms: data.parseMs,
      save_ms: Date.now() - started,
    },
    consent,
  );
  return {
    exporter: data.exporter,
    saved: passwords.saved,
    existing: passwords.existing,
    failed: passwords.failed,
    codes: saved.saved,
    codesFailed: saved.failed,
    passkeys: data.passkeys,
    skipped: noSite + data.unsupported,
  };
}

export function exchangeSummary(result: ExchangeResult): string {
  const skipped = result.existing + result.failed + result.skipped;
  const codes = result.codes ? ` and ${plural(result.codes, "verification code")}` : "";
  return `Imported ${plural(result.saved, "password")}${codes} from ${result.exporter || "your password manager"}.${skipped ? ` ${skipped.toLocaleString("en-US")} skipped.` : ""}`;
}

export function exchangeResultLines(result: ExchangeResult): string[] {
  const lines: string[] = [];
  if (result.codes) lines.push(`${plural(result.codes, "verification code")} saved with ${result.codes === 1 ? "its login" : "their logins"}.`);
  if (result.existing) lines.push(`${plural(result.existing, "password")} ${result.existing === 1 ? "was" : "were"} already saved.`);
  const failed = result.failed + result.codesFailed;
  if (failed) lines.push(`${failed.toLocaleString("en-US")} couldn't be saved.`);
  if (result.skipped) lines.push(`${plural(result.skipped, "item")} skipped: no website, or not a password or code.`);
  if (result.passkeys) lines.push(`${plural(result.passkeys, "passkey")} stayed in ${result.exporter || "the other app"}: Ardia can't store imported passkeys yet.`);
  return lines;
}

const WINDOW_DEADLINE_MS = 5000;

function showStep(step: ImportStep) {
  if (importWindowOpen()) return patchImport({ source: null, step });
  enterImportAt(step);
  openImport();
}

export function openPasswordManagerImport() {
  showStep({ name: "exchange", phase: "waiting", exporter: null, error: null });
}

export async function askPasswordManager() {
  const answer = await requestCredentialExchange();
  if (answer === "failed") patchImport({ step: { name: "exchange", phase: "waiting", exporter: null, error: "Couldn't open Passwords. Open it from your Applications folder." } });
}

let receiving = false;

async function receiveExchanges(consent: ConsentToken | null) {
  if (receiving) return;
  receiving = true;
  try {
    while (credentialExchangeStatus().pending > 0) await receiveOne(consent);
  } finally {
    receiving = false;
  }
}

async function receiveOne(consent: ConsentToken | null) {
  showStep({ name: "exchange", phase: "importing", exporter: null, error: null });
  await whenImportWindowOpen(WINDOW_DEADLINE_MS);
  let data: ExchangedCredentials | null;
  try {
    data = await takeExchangedCredentials();
  } catch (error) {
    noteCredentialExchangeFailure("receive", consent);
    const unsupported = ardiaError(error).code === "unsupported";
    patchImport({ step: { name: "exchange", phase: "waiting", exporter: null, error: unsupported ? "That export isn't one Ardia can read." : "The other app's export didn't arrive. Try exporting again." } });
    return;
  }
  if (!data) return;
  patchImport({ step: { name: "exchange", phase: "importing", exporter: data.exporter, error: null } });
  const signal = importSignal();
  try {
    const result = await saveExchangedCredentials(engineProfile(useBrowser.getState(), importNow().target), data, consent);
    useLastExchange.setState({ result });
    finishImport(signal, { counts: { ...emptyCounts(), passwords: result.saved }, failures: [], notes: exchangeResultLines(result), extensions: NO_EXTENSIONS });
  } catch {
    noteCredentialExchangeFailure("save", consent);
    patchImport({ step: { name: "exchange", phase: "waiting", exporter: data.exporter, error: "Couldn't save what came over. Try exporting again." } });
  }
}

export function startCredentialExchange() {
  if (!credentialExchangeStatus().supported) return;
  onCredentialExchange(() => void receiveExchanges(consentToken()));
  void receiveExchanges(consentToken());
}
