export type Binding = "service" | "custom" | "absent";

export type DesktopBinding = "route" | "custom" | "absent";

export type EventBinding = "forward" | "custom" | "absent";

export type Call = {
  args: string;
  result: string;
  service?: string;
  desktop: DesktopBinding;
  routeField?: string;
  deadline?: number;
  mac?: Binding;
  windows?: Binding;
};

export type Event = {
  payload: string;
  topic?: string;
  desktop: EventBinding;
  mac?: EventBinding;
  windows?: EventBinding;
};

export type EngineDomain = {
  kind: "engine";
  imports: Record<string, readonly string[]>;
  calls: Record<string, Call>;
  events: Record<string, Event>;
};

export type Domain = EngineDomain;

export function defineDomain<const D extends Domain>(domain: D): D {
  return domain;
}

export type ModuleBinding = "custom" | "absent";

export type DesktopModuleBinding = "custom" | "adapted" | "host" | "absent";

export type Parameter = readonly [name: string, type: string] | readonly [name: string, type: string, swift: string];

export type ModuleQueue = "main" | "module" | "userInitiated" | "utility";

export type ModuleFunction = {
  args: readonly Parameter[];
  result: string;
  swiftResult?: string;
  async: boolean;
  optional?: true;
  promise?: true;
  queue?: ModuleQueue;
  swiftAsync?: true;
  throws?: true;
  instance?: "strong" | "weak";
  fallback?: string;
  debug?: true;
  deadline?: number;
  mac: ModuleBinding;
  desktop: DesktopModuleBinding;
  windows: ModuleBinding;
};

export type ModuleConstant = {
  type: string;
  swift?: string;
  optional?: true;
  mac: ModuleBinding;
  desktop: DesktopModuleBinding;
  windows: ModuleBinding;
};

export type ModuleEvent = {
  payload: string;
  mac: ModuleBinding;
  desktop: DesktopModuleBinding;
  windows: ModuleBinding;
};

export type NativeModule = {
  functions: Record<string, ModuleFunction>;
  constants?: Record<string, ModuleConstant>;
  events: Record<string, ModuleEvent>;
};

export type ModuleDomain = {
  kind: "module";
  package: string;
  imports: Record<string, readonly string[]>;
  types: Record<string, string>;
  modules: Record<string, NativeModule>;
};

export function defineModuleDomain<const D extends ModuleDomain>(domain: D): D {
  return domain;
}

export type DesktopHost = {
  routeOrder: readonly string[];
  deadlines: Record<string, number>;
};

export function defineDesktopHost<const D extends DesktopHost>(host: D): D {
  return host;
}
