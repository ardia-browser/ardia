import type { OpenWindowOptions } from "@ardia/shell";
import { TurboModuleRegistry, type TurboModule } from "react-native";
import { windowsMotion } from "./animation/motion";
import { addNativeListener, type EventSubscription } from "./events";
import { moduleDefaults } from "./defaults";
import { engineAvailable } from "./engine/host";
import { engineModules } from "./engine/modules";
import { listenedOnWindows } from "./engine/popupCommands";
import { windowsImport } from "./import";
import { windowsInlineCompletion } from "./inlineCompletion";
import { windowsShellClipboard } from "./shellClipboard";
import type { DialogsModule, MenusModule, WindowsHostModule } from "./nativeModuleTypes";
import { windowsIntroMusic } from "./introMusic";
import { watchDialogsWith, windowsDialogPages } from "./engine/dialogPages";
import { windowsExternalAppCounts } from "./engine/domains/externalApps";
import { windowsLaunchLinks } from "./launchLinks";
import { noteMissing } from "./missing";
import { windowsSelfChecks } from "./selfCheck/registered";
import { stampedSystemInfo, windowsUpdater } from "./updater";
import { windowsSwipe } from "./pager";
import { windowsSync } from "./sync";
import { setWindowDark } from "./windowDark";
import { noteAppWindow } from "./engine/popupsAsTabs";

type Listener = (payload: unknown) => void;
type NativeModule = TurboModule & Record<string, unknown>;

type Call = (...values: unknown[]) => unknown;

const modules = new Map<string, object>();

const RELEASE_NOTES_PAGE = "https://ardia.dev/release-notes";

const around: Record<string, Record<string, (native: Call) => Call>> = {
  ArdiaApp: {
    systemInfo: (native) => () => {
      const info = stampedSystemInfo(native());
      if (typeof info !== "object" || info === null) return info;
      return { releaseNotesURL: RELEASE_NOTES_PAGE, ...info };
    },
  },
  ArdiaAppWindows: {
    openWindow: (native) => (id, options) => {
      setWindowDark(String(id), !!(options as { incognito?: unknown } | null)?.incognito);
      noteAppWindow(String(id), (options as OpenWindowOptions | null)?.kind);
      return native(id, options);
    },
  },
};

const syncOnWindows = windowsSync();

watchDialogsWith(() => (TurboModuleRegistry.get<TurboModule & Pick<DialogsModule, "openCount">>("ArdiaDialogs")?.openCount() ?? 0) + (TurboModuleRegistry.get<TurboModule & Pick<MenusModule, "openCount">>("ArdiaMenus")?.openCount() ?? 0) > 0);

const writtenInJs: Record<string, Record<string, unknown>> = { ...(syncOnWindows ? { ArdiaSync: syncOnWindows } : {}), ArdiaUpdater: windowsUpdater, ArdiaSwipe: windowsSwipe, ArdiaMotion: windowsMotion, ArdiaLaunchLinks: windowsLaunchLinks, ArdiaExternalAppCounts: windowsExternalAppCounts, ArdiaDialogPages: windowsDialogPages, ArdiaImport: windowsImport(), ArdiaInlineCompletion: windowsInlineCompletion(() => TurboModuleRegistry.get<TurboModule & WindowsHostModule>("ArdiaWindowsHost")), ArdiaApp: windowsIntroMusic, ArdiaSelfCheck: windowsSelfChecks, ArdiaShell: windowsShellClipboard(() => TurboModuleRegistry.get<TurboModule & { copyText?(text: string): void }>("ArdiaShell")) };

const inert = (module: string, key: string) => () => {
  noteMissing(`${module}.${key}`);
  return Promise.resolve(null);
};

function moduleOnWindows(name: string): object {
  const cached = modules.get(name);
  if (cached) return cached;
  const native = TurboModuleRegistry.get<TurboModule>(name) as NativeModule | null;
  const constants = (native?.getConstants?.() ?? {}) as Record<string, unknown>;
  const defaults = moduleDefaults[name] ?? {};
  const made = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string" || key === "then" || key === "$$typeof") return undefined;
        const fromNative = native?.[key];
        const wrap = around[name]?.[key];
        if (wrap && typeof fromNative === "function") return wrap(fromNative as Call);
        if (fromNative !== undefined) return fromNative;
        if (Object.hasOwn(constants, key)) return constants[key];
        const inJs = writtenInJs[name];
        if (inJs && Object.hasOwn(inJs, key)) return inJs[key];
        const withEngine = engineModules[name];
        if (withEngine && Object.hasOwn(withEngine, key) && engineAvailable()) return withEngine[key];
        if (Object.hasOwn(defaults, key)) {
          noteMissing(`${name}.${key}`);
          return defaults[key];
        }
        if (key === "addListener") return (event: string, listener: Listener): EventSubscription => addNativeListener(name, event, listenedOnWindows(name, event, listener));
        if (key === "removeListeners" || key === "removeAllListeners") return () => {};
        return inert(name, key);
      },
    },
  );
  modules.set(name, made);
  return made;
}

export function requireNativeModule<Module = unknown>(name: string): Module {
  return moduleOnWindows(name) as Module;
}

export function requireOptionalNativeModule<Module = unknown>(name: string): Module | null {
  return TurboModuleRegistry.get<TurboModule>(name) || moduleDefaults[name] || engineModules[name] || writtenInJs[name] ? (moduleOnWindows(name) as Module) : null;
}
