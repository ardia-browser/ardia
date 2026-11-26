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
  type PluginStreamSpec,
  type PluginStreamHead,
  type PluginSocketSpec,
  type PluginSocketOpen,
  type PluginNetOutcome,
  type PluginUsageRow,
  type PluginAuthSpec,
  type PluginAuthResult,
  type PluginPickSpec,
  type PluginPickResult,
  type PluginPickedFile,
  type PluginSaveSpec,
  type PluginSaveResult,
  type PluginDropSpec,
  type PluginChunkResult,
  type PluginImageSpec,
  type PluginImageResult,
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
  PluginStreamSpec,
  PluginStreamHead,
  PluginSocketSpec,
  PluginSocketOpen,
  PluginNetOutcome,
  PluginUsageRow,
  PluginAuthSpec,
  PluginAuthResult,
  PluginPickSpec,
  PluginPickResult,
  PluginPickedFile,
  PluginSaveSpec,
  PluginSaveResult,
  PluginDropSpec,
  PluginChunkResult,
  PluginImageSpec,
  PluginImageResult,
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
export const startPluginStream = (spec: PluginStreamSpec) => Plugins().fetchStream(spec);
export const cancelPluginStream = (name: string, run: number, stream: string) => Plugins().cancelStream(name, run, stream);
export const connectPluginSocket = (spec: PluginSocketSpec) => Plugins().wsConnect(spec);
export const sendPluginSocket = (name: string, run: number, socket: string, data: string, binary: boolean) => Plugins().wsSend(name, run, socket, data, binary);
export const closePluginSocket = (name: string, run: number, socket: string, code: number, reason: string) => Plugins().wsClose(name, run, socket, code, reason);
export const closePluginNet = (name: string, run: number) => Plugins().closeNet(name, run);
export const pluginUsage = () => Plugins().usage();
export const pluginSignIn = (spec: PluginAuthSpec) => Plugins().authSignIn(spec);
export const pickPluginFiles = (spec: PluginPickSpec) => Plugins().pickFiles(spec);
export const openDroppedPluginFiles = (spec: PluginDropSpec) => Plugins().openDroppedFiles(spec);
export const readPluginFileChunk = (name: string, run: number, handle: string, offset: number, length: number) => Plugins().readFileChunk(name, run, handle, offset, length);
export const beginPluginSave = (spec: PluginSaveSpec) => Plugins().saveBegin(spec);
export const savePluginChunk = (name: string, run: number, handle: string, data: string) => Plugins().saveChunk(name, run, handle, data);
export const finishPluginFile = (name: string, run: number, handle: string, commit: boolean) => Plugins().finishFile(name, run, handle, commit);
export const loadPluginImage = (spec: PluginImageSpec) => Plugins().loadImage(spec);
export const readPluginAssetImage = (name: string, folderId: string, approved: string, path: string) => Plugins().readPluginAsset(name, folderId, approved, path);
