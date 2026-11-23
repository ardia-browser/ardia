export type Binding = "service" | "custom" | "absent";

export type DesktopBinding = "route" | "custom" | "absent";

export type EventBinding = "forward" | "custom" | "absent";

export type Call = {
  args: string;
  result: string;
  service?: string;
  desktop: DesktopBinding;
  routeField?: string;
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
