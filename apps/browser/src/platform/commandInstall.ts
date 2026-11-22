import { nativeModule, type CliInstallResult } from "@ardia/shell";
import { t } from "../lib/uiLanguage";


export type CommandInstallResult = CliInstallResult;

let bound: ReturnType<typeof nativeModule<t(`ArdiaCli`)>> | null = null;
const Installer = () => (bound ??= nativeModule(t(`ArdiaCli`)));

export const installedCommandVersion = () => Installer().installedVersion();
export const canInstallCommandUnattended = () => Installer().canInstallUnattended();
export const installCommand = () => Installer().install();
export const onCommandInstallLine = (listener: (line: string) => void) => Installer().addListener("onInstallLine", (e) => listener(e.line));
