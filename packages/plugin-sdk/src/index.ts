import type { Ardia } from "./api";
import type { Transport } from "./rpc";
import { createHostRuntime, type HostRuntime } from "./runtime";
import type { PluginDefinition } from "./types";

export * from "./jsx";
export * from "./components";
export * from "./protocol";
export { createHostRuntime, SDK_VERSION, type HostRuntime, type HostRuntimeOptions } from "./runtime";
export { createRpc, PluginError, type Rpc, type Transport } from "./rpc";
export { useSurface, type SurfaceInfo } from "./surfaces";
export { joinGroupPages, type GroupPages } from "./stateMirror";
export type { Ardia, PluginInfo, PluginResponse } from "./api";
export type {
  Awaitable,
  CallContext,
  CancelSignal,
  CommandHandler,
  DecideHandler,
  Disposable,
  EventListener,
  OmniboxProvider,
  PageMessageListener,
  PluginDefinition,
  SettingsListener,
  StateListener,
  ToolHandler,
  ViewComponent,
  ViewProps,
} from "./types";
export type {
  ActionPanelProps,
  ActionProps,
  BadgeProps,
  BoxProps,
  ButtonProps,
  CopyToClipboardProps,
  DetailMetadata,
  DetailProps,
  DividerProps,
  EmptyStateProps,
  FormProps,
  FormValues,
  ListAccessory,
  ListItemProps,
  ListProps,
  ListSectionProps,
  MarkdownProps,
  OpenInBrowserProps,
  PasswordFieldProps,
  PopoverProps,
  ProgressProps,
  SelectOption,
  SelectProps,
  SidebarItemProps,
  SidebarSectionProps,
  SidebarViewProps,
  TextFieldProps,
  TextProps,
  ToggleProps,
  WebViewProps,
} from "./componentProps";

let shared: HostRuntime | null = null;

function bridge(): Transport {
  const found = (globalThis as { __ardiaBridge?: Transport }).__ardiaBridge;
  if (!found || typeof found.send !== "function" || typeof found.onLine !== "function") {
    throw new Error("There's no __ardiaBridge; plugins built with @ardia/plugin-sdk run inside Ardia's plugin host.");
  }
  return found;
}

export function sharedRuntime(): HostRuntime {
  shared ??= createHostRuntime(bridge());
  return shared;
}

export const ardia: Ardia = new Proxy({} as Ardia, {
  get: (_target, key) => Reflect.get(sharedRuntime().ardia, key),
  has: (_target, key) => Reflect.has(sharedRuntime().ardia, key),
});

export function definePlugin(definition: PluginDefinition<Ardia>): Promise<void> {
  return sharedRuntime().definePlugin(definition);
}
