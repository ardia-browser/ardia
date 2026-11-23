import { canInstallCommandUnattended, installCommand, installedCommandVersion, onCommandInstallLine, type CommandInstallResult } from "../../platform/commandInstall";
import { readDocument, writeDocument } from "../../platform/documents";
import { systemInfo } from "../../platform/app";
import { create } from "zustand";
import { useBrowser } from "../browser/store";
import { afterFirstWindow } from "../../lib/afterFirstWindow";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { parseSaved, unchanged, versionedJson, type Migrations } from "../../lib/savedDocument";
import { errorText } from "../../lib/errors";
import { noteCliAutoEnabled, noteCliInstall, type CliInstallReason } from "../telemetry/cliCounts";
import { consentToken } from "../telemetry/client";
import { programControlOn, setProgramControl, userTurnedControlOff } from "./programControlSetting";

export const installsCommandItself = PLATFORM_FEATURES.ardiaCommand && !PLATFORM_FEATURES.plugins;

const DOC = "ardia-cli.json";
const DOC_VERSION = 1;
const DOC_MIGRATIONS: Migrations = { 0: unchanged };
const SCHEMA_FIELD = "schemaVersion";
const UPGRADE_DELAY_MS = 8000;
const AUTO_INSTALL_TRIES = 3;

type Saved = {
  binPath?: string | null;
  version?: string | null;
  error?: string | null;
  at?: number;
  autoInstalledAt?: number;
  autoInstallTries?: number;
};

type CommandInstallState = {
  installing: CliInstallReason | null;
  step: string | null;
  installedVersion: string | null;
  binPath: string | null;
  error: string | null;
};

function readSaved(): Saved {
  try {
    return (parseSaved(readDocument(DOC), DOC_VERSION, DOC_MIGRATIONS, SCHEMA_FIELD) as Saved | null) ?? {};
  } catch {
    return {};
  }
}

function save(patch: Saved): boolean {
  try {
    writeDocument(DOC, versionedJson({ ...readSaved(), ...patch, at: Date.now() }, DOC_VERSION, SCHEMA_FIELD));
    return true;
  } catch (error) {
    console.warn("[command install] couldn't save the install status", error);
    return false;
  }
}

const saved = readSaved();

export const useCommandInstall = create<CommandInstallState>()(() => ({
  installing: null,
  step: null,
  installedVersion: installsCommandItself ? installedCommandVersion() : null,
  binPath: saved.binPath ?? null,
  error: saved.error ?? null,
}));

let running: Promise<CommandInstallResult> | null = null;

export function installCommandInBackground(reason: CliInstallReason): Promise<CommandInstallResult> {
  if (running) return running;
  const consent = consentToken();
  useCommandInstall.setState({ installing: reason, step: null });
  const lines = onCommandInstallLine((line) => {
    const step = /^step (\S+)/.exec(line)?.[1];
    if (step) useCommandInstall.setState({ step });
  });
  running = installCommand()
    .then((result): CommandInstallResult => result ?? { ok: false, appVersion: "", error: "The installer stopped.", lines: [] })
    .catch((e: unknown): CommandInstallResult => ({ ok: false, appVersion: "", error: errorText(e), lines: [] }))
    .then((result) => {
      lines.remove();
      running = null;
      noteCliInstall(reason, result.ok, consent);
      const installedVersion = installedCommandVersion();
      if (result.ok) {
        save({ binPath: result.binPath ?? null, version: result.version ?? installedVersion, error: null });
        useCommandInstall.setState({ installing: null, step: null, installedVersion, binPath: result.binPath ?? null, error: null });
      } else {
        const error = result.error ?? "The installer stopped.";
        save({ error });
        useCommandInstall.setState({ installing: null, step: null, installedVersion, error });
      }
      return result;
    });
  return running;
}

export function describeCommandInstall(state: Pick<CommandInstallState, "installing" | "step" | "installedVersion" | "binPath" | "error">): string {
  if (state.installing) return state.step ? `Installing (${state.step})…` : "Installing…";
  if (state.error) return state.error;
  if (state.installedVersion) return state.binPath ? `Installed at ${state.binPath}` : `Version ${state.installedVersion} is installed.`;
  return "Not installed.";
}

function neverInstalled(record: Saved) {
  return !record.autoInstalledAt && !record.autoInstallTries && !record.version && !record.binPath;
}

const autoInstallUnfinished = (record: Saved) => !!record.autoInstallTries && !record.autoInstalledAt;

function finishAutoInstall() {
  save({ autoInstalledAt: Date.now() });
  if (programControlOn(useBrowser.getState()) || userTurnedControlOff()) return;
  setProgramControl(true);
  noteCliAutoEnabled();
}

async function installForTheFirstTime() {
  if (userTurnedControlOff() || !canInstallCommandUnattended()) return;
  const tries = readSaved().autoInstallTries ?? 0;
  if (tries >= AUTO_INSTALL_TRIES || !save({ autoInstallTries: tries + 1 }) || readSaved().autoInstallTries !== tries + 1) return;
  const result = await installCommandInBackground("auto");
  if (result.ok) finishAutoInstall();
}

function installOrUpgradeCommand() {
  const installed = installedCommandVersion();
  useCommandInstall.setState({ installedVersion: installed });
  const record = readSaved();
  if (!installed) {
    if (neverInstalled(record) || autoInstallUnfinished(record)) void installForTheFirstTime();
    return;
  }
  if (autoInstallUnfinished(record)) finishAutoInstall();
  const app = systemInfo().appVersion;
  if (!app || installed === app) return;
  void installCommandInBackground("upgrade");
}

export function startCommandInstall() {
  if (installsCommandItself) afterFirstWindow(() => setTimeout(installOrUpgradeCommand, UPGRADE_DELAY_MS));
}
