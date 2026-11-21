import {
  nativeModule,
  type PluginExit,
  type PluginFetchResult,
  type PluginFetchSpec,
  type PluginFileReadResult,
  type PluginFolderEntry,
  type PluginLine,
  type PluginProgramsResult,
  type PluginProgramsSpec,
  type PluginProgramRegistry,
  type PluginRemoveResult,
  type PluginStartResult,
  type PluginStartSpec,
  type PluginStorageReadResult,
} from "@ardia/shell";

export type {
  PluginExit,
  PluginFetchResult,
  PluginFetchSpec,
  PluginFileReadResult,
  PluginFolderEntry,
  PluginLine,
  PluginProgramsResult,
  PluginProgramsSpec,
  PluginProgramRegistry,
  PluginRemoveResult,
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
export const removePluginFiles = (name: string) => Plugins().remove(name);
export const linkPluginPrograms = (spec: PluginProgramsSpec) => Plugins().linkPrograms(spec);
export const unlinkPluginPrograms = (name: string, programs: string[], remove: boolean) => Plugins().unlinkPrograms(name, programs, remove);
export const sweepPluginPrograms = (active: string[]) => Plugins().sweepPrograms(active);
export const legacyProgramsInstalled = () => Plugins().legacyProgramsInstalled();
export const programRegistry = () => Plugins().programRegistry();
export const revealPluginLog = (name: string) => Plugins().revealLog(name);
export const revealPluginsFolder = () => Plugins().revealFolder();
export const devSnapshotPluginPage = (name: string, path: string) => Plugins().devSnapshotPage(name, path);
export const hostFetchPlugin = (spec: PluginFetchSpec) => Plugins().hostFetch(spec);
export const readPluginStorage = (name: string) => Plugins().storageRead(name);
export const writePluginStorage = (name: string, text: string) => Plugins().storageWrite(name, text);
export const readPluginFile = (name: string, folderId: string, approved: string, path: string) => Plugins().readPluginFile(name, folderId, approved, path);
export const onPluginLine = (listener: (e: PluginLine) => void) => Plugins().addListener("onLine", listener);
export const onPluginExit = (listener: (e: PluginExit) => void) => Plugins().addListener("onExit", listener);
