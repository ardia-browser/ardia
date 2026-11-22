import { nativeModule, type CliInstallResult } from "@ardia/shell";

export type CommandInstallResult = CliInstallResult;

let bound: ReturnType<typeof nativeModule<"ArdiaCli">> | null = null;
const Installer = () => (bound ??= nativeModule("ArdiaCli"));

export const installedCommandVersion = () => Installer().installedVersion();
export const canInstallCommandUnattended = () => Installer().canInstallUnattended();
export const installCommand = () => Installer().install();
export const onCommandInstallLine = (listener: (line: string) => void) => Installer().addListener("onInstallLine", (e) => listener(e.line));
