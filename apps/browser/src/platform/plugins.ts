import {
  nativeModule,
  type CredentialProviderResult,
  type CredentialRunWanted,
  type OfficialCandidate,
  type OfficialFetchProgress,
  type OfficialFetchResult,
  type OfficialPinned,
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
import { PLATFORM_FEATURES } from "../lib/platformFeatures";

export type {
  CredentialProviderResult,
  CredentialRunWanted,
  OfficialCandidate,
  OfficialFetchProgress,
  OfficialFetchResult,
  OfficialPinned,
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
export const removePluginFiles = (name: string, official: boolean, folderId: string | null) => Plugins().remove(name, official, folderId);
export const linkPluginPrograms = (spec: PluginProgramsSpec) => Plugins().linkPrograms(spec);
export const unlinkPluginPrograms = (name: string, programs: string[], remove: boolean) => Plugins().unlinkPrograms(name, programs, remove);
export const sweepPluginPrograms = (active: string[]) => Plugins().sweepPrograms(active);
export const takeAfterUpdateQuitStops = () => Plugins().takeAfterUpdateQuitStops();
export const setAfterUpdateQuitConsent = (consent: string) => Plugins().setAfterUpdateQuitConsent(consent);
export const legacyProgramsInstalled = () => Plugins().legacyProgramsInstalled();
export const programRegistry = () => Plugins().programRegistry();
export const revealPluginLog = (name: string) => Plugins().revealLog(name);
export const revealPluginsFolder = () => Plugins().revealFolder();
export const devSnapshotPluginPage = (name: string, path: string) => Plugins().devSnapshotPage(name, path);
export const officialPluginsPinned = () => Plugins().officialPlugins();
export const fetchOfficialPlugin = (name: string) => Plugins().fetchOfficial(name);
export const cancelOfficialPluginFetch = (name: string) => Plugins().cancelOfficialFetch(name);
export const promoteOfficialPlugin = (name: string, folderId: string, approved: string) => Plugins().promoteOfficial(name, folderId, approved);
export const onOfficialFetchProgress = (listener: (e: OfficialFetchProgress) => void) => Plugins().addListener("onOfficialFetch", listener);
export const hostFetchPlugin = (spec: PluginFetchSpec) => Plugins().hostFetch(spec);
export const readPluginStorage = (name: string) => Plugins().storageRead(name);
export const writePluginStorage = (name: string, text: string) => Plugins().storageWrite(name, text);
export const readPluginFile = (name: string, folderId: string, approved: string, path: string) => Plugins().readPluginFile(name, folderId, approved, path);
export const onPluginLine = (listener: (e: PluginLine) => void) => Plugins().addListener("onLine", listener);
export const onPluginExit = (listener: (e: PluginExit) => void) => Plugins().addListener("onExit", listener);
const credentialProvidersHere = () => PLATFORM_FEATURES.plugins;
const credentialProvidersAbsent: CredentialProviderResult = { ok: false, reason: "password manager plugins are Mac-only" };
const noCredentialRuns = { remove: () => {} };

export const setCredentialProvider = (name: string, enabled: boolean): Promise<CredentialProviderResult> =>
  credentialProvidersHere() ? Plugins().setCredentialProvider(name, enabled) : Promise.resolve(credentialProvidersAbsent);
export const forgetCredentialProvider = (name: string): Promise<CredentialProviderResult> =>
  credentialProvidersHere() ? Plugins().forgetCredentialProvider(name) : Promise.resolve(credentialProvidersAbsent);
export const onCredentialRunWanted = (listener: (e: CredentialRunWanted) => void) =>
  credentialProvidersHere() ? Plugins().addListener("onCredentialRunWanted", listener) : noCredentialRuns;
