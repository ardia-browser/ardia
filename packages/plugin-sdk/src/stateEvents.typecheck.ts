import type { Ardia } from "./api";
import type { StateEventMap } from "./protocol";

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

declare const ardia: Ardia;

type MoreOf<K extends keyof StateEventMap> = StateEventMap[K]["more"];

export const everyStateChangeSaysMore: [Same<MoreOf<"tabs">, true | undefined>, Same<MoreOf<"workspace">, true | undefined>, Same<MoreOf<"navigation">, true | undefined>, Same<MoreOf<"downloads">, true | undefined>] = [true, true, true, true];

export const navigationRoundsAreTyped = ardia.state.subscribe("navigation", (change) => {
  const more: boolean = change.more === true;
  const urls: string[] = change.commits.map((c) => c.url);
  return [more, urls];
});
