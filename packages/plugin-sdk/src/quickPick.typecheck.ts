import type { Ardia } from "./api";
import type { QuickPickItem, QuickPickOptions } from "./protocol";

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

declare const ardia: Ardia;
declare const items: readonly QuickPickItem[];
declare const widened: QuickPickOptions;

const many = ardia.ui.quickPick(items, { canPickMany: true });
const one = ardia.ui.quickPick(items, { canPickMany: false, title: "Pick" });
const plain = ardia.ui.quickPick(items);
const titled = ardia.ui.quickPick(items, { title: "Pick" });
const either = ardia.ui.quickPick(items, widened);

export const quickPickReturnTypes: [
  Same<Awaited<typeof many>, QuickPickItem[] | undefined>,
  Same<Awaited<typeof one>, QuickPickItem | undefined>,
  Same<Awaited<typeof plain>, QuickPickItem | undefined>,
  Same<Awaited<typeof titled>, QuickPickItem | undefined>,
  Same<Awaited<typeof either>, QuickPickItem | QuickPickItem[] | undefined>,
] = [true, true, true, true, true];
