export type Binding = "service" | "custom" | "absent";

export type DesktopBinding = "route" | "custom" | "absent";

export type Call = {
  args: string;
  result: string;
  service?: string;
  desktop: DesktopBinding;
  mac?: Binding;
  windows?: Binding;
};

export type EngineDomain = {
  kind: "engine";
  imports: Record<string, readonly string[]>;
  calls: Record<string, Call>;
  events: Record<string, string>;
};

export type Domain = EngineDomain;

export function defineDomain<const D extends Domain>(domain: D): D {
  return domain;
}
