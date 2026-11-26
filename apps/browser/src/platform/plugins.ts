import {
  nativeModule,
  type PluginArtifactProgress,
  type PluginArtifactResult,
  type PluginArtifactSpec,
  type PluginExit,
  type PluginFetchResult,
  type PluginFetchSpec,
  type PluginFileReadResult,
  type PluginFolderEntry,
  type PluginLine,
  type PluginProgramsResult,
  type PluginProgramsSpec,
  type PluginLegacyAdoption,
  type PluginLocalInstallResult,
  type PluginRemoveResult,
  type PluginSource,
  type PluginStoreCandidate,
  type PluginStoreSwitchResult,
  type PluginStartResult,
  type PluginStartSpec,
  type PluginStorageReadResult,
} from "@ardia/shell";

export type {
  PluginArtifactProgress,
  PluginArtifactResult,
  PluginArtifactSpec,
  PluginExit,
  PluginFetchResult,
  PluginFetchSpec,
  PluginFileReadResult,
  PluginFolderEntry,
  PluginLine,
  PluginProgramsResult,
  PluginProgramsSpec,
  PluginLegacyAdoption,
  PluginLocalInstallResult,
  PluginRemoveResult,
  PluginSource,
  PluginStoreCandidate,
  PluginStoreSwitchResult,
  PluginStartResult,
  PluginStartSpec,
  PluginStorageReadResult,
};

let bound: ReturnType<typeof nativeModule<"ArdiaPlugins">> | null = null;
const Plugins = () => (bound ??= nativeModule("ArdiaPlugins"));

export const pluginsFolder = () => Plugins().folder();
export const listPluginFolders = () => Plugins().list();
export const startPluginProcess = (spec: PluginStartSpec) => Plugins().start(spec);
export const stopPluginProcess = (name: string, run: number, graceMs: number) => Plugins().stop(name, run, graceMs);
export const replyToPlugin = (name: string, run: number, line: string) => Plugins().reply(name, run, line);
export const sendToPlugin = (name: string, run: number, line: string) => Plugins().event(name, run, line);
export const callPlugin = (name: string, run: number, line: string) => Plugins().call(name, run, line);
export const removePluginFiles = (name: string, source: PluginSource, folderId: string | null) => Plugins().remove(name, source, folderId);
export const linkPluginPrograms = (spec: PluginProgramsSpec) => Plugins().linkPrograms(spec);
export const unlinkPluginPrograms = (name: string, programs: string[], remove: boolean) => Plugins().unlinkPrograms(name, programs, remove);
export const sweepPluginPrograms = (active: string[]) => Plugins().sweepPrograms(active);
export const takeAfterUpdateQuitStops = () => Plugins().takeAfterUpdateQuitStops();
export const setAfterUpdateQuitConsent = (consent: string) => Plugins().setAfterUpdateQuitConsent(consent);
export const revealPluginLog = (name: string) => Plugins().revealLog(name);
export const revealPluginsFolder = () => Plugins().revealFolder();
export const devSnapshotPluginPage = (name: string, path: string) => Plugins().devSnapshotPage(name, path);
export const fetchPluginArtifact = (spec: PluginArtifactSpec) => Plugins().fetchArtifact(spec);
export const cancelPluginArtifactFetch = (name: string) => Plugins().cancelArtifactFetch(name);
export const installPluginArchive = (path: string) => Plugins().installArchiveFile(path);
export const installPluginFolder = (path: string) => Plugins().installFolder(path);
export const activateStorePlugin = (name: string, folderId: string, approved: string) => Plugins().activateStore(name, folderId, approved);
export const rollbackStorePlugin = (name: string, expectedVersion: string, expectedSha256: string) => Plugins().rollbackStore(name, expectedVersion, expectedSha256);
export const adoptLegacyPlugin = (from: string, to: string) => Plugins().adoptLegacy(from, to);
export const onPluginArtifactProgress = (listener: (e: PluginArtifactProgress) => void) => Plugins().addListener("onArtifactFetch", listener);
export const nativeVerifySignature = (publicKey: string, signature: string, message: string) => Plugins().verifySignature(publicKey, signature, message);
export const hostFetchPlugin = (spec: PluginFetchSpec) => Plugins().hostFetch(spec);
export const readPluginStorage = (name: string) => Plugins().storageRead(name);
export const writePluginStorage = (name: string, text: string) => Plugins().storageWrite(name, text);
export const readPluginFile = (name: string, folderId: string, approved: string, path: string) => Plugins().readPluginFile(name, folderId, approved, path);
export const onPluginLine = (listener: (e: PluginLine) => void) => Plugins().addListener("onLine", listener);
export const onPluginExit = (listener: (e: PluginExit) => void) => Plugins().addListener("onExit", listener);
