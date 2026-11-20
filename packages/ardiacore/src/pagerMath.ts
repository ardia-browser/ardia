export type LeadingView = {
  atLeading: boolean;
  home: number;
  floor: number;
  pagePosition: number;
  lead: number;
};

export function leadingView(anchor: number | null, selected: number, position: number, leading: boolean): LeadingView {
  if (anchor === null) return { atLeading: false, home: selected, floor: 0, pagePosition: position, lead: 0 };
  const atLeading = selected === anchor - 1;
  return {
    atLeading,
    home: atLeading ? anchor : selected,
    floor: leading ? anchor - 1 : anchor,
    pagePosition: Math.max(position, anchor),
    lead: Math.max(0, anchor - position),
  };
}

export type StepAction = { kind: "stay" } | { kind: "lead" } | { kind: "switch"; index: number };

export function stepAction(
  { anchor, selected, leading, count }: { anchor: number | null; selected: number; leading: boolean; count: number },
  delta: number,
  wrap: boolean,
): StepAction {
  const view = leadingView(anchor, selected, 0, leading);
  if (wrap) {
    const index = (((view.home + delta) % count) + count) % count;
    return index === view.home ? { kind: "stay" } : { kind: "switch", index };
  }
  const floor = leading && anchor === null && selected === 0 ? -1 : view.floor;
  const target = Math.min(Math.max(selected + delta, floor), count - 1);
  if (target === selected) return { kind: "stay" };
  return target < 0 || (anchor !== null && target === anchor - 1) ? { kind: "lead" } : { kind: "switch", index: target };
}

export const OMEGA = (2 * Math.PI) / 0.25;
export const REST_DISPLACEMENT = 0.003;
export const REST_SPEED = 0.1;

export function springAt(from: number, target: number, velocity: number, seconds: number) {
  const x0 = from - target;
  const b = velocity + OMEGA * x0;
  const decay = Math.exp(-OMEGA * seconds);
  const offset = (x0 + b * seconds) * decay;
  const speed = (velocity - OMEGA * b * seconds) * decay;
  return { offset, velocity: speed, rested: Math.abs(offset) < REST_DISPLACEMENT && Math.abs(speed) < REST_SPEED };
}

export const sameOrder = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((id, i) => id === b[i]));

export const clampIndex = (index: number, count: number) => Math.min(Math.max(index, 0), count - 1);
