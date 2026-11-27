export type SaveShown = "none" | "saving" | "saved" | "unsaved" | "blocked";

export type SaveStateLike = { state: "saved" | "saving" | "unsaved" | "blocked"; refused: number };

export type SaveStep = { show: SaveShown | "saving-later" | "keep"; fadeAfterSaved: boolean; toastRefused: boolean };

export function decideSave(visible: SaveShown, slowPending: boolean, refusedSeen: number, next: SaveStateLike): SaveStep {
  const toastRefused = next.refused > refusedSeen;
  if (next.state === "blocked") return { show: "blocked", fadeAfterSaved: false, toastRefused };
  if (next.state === "unsaved") return { show: "unsaved", fadeAfterSaved: false, toastRefused };
  if (next.state === "saving") {
    if (visible === "unsaved" || visible === "blocked" || visible === "saving" || slowPending) return { show: "keep", fadeAfterSaved: false, toastRefused };
    return { show: "saving-later", fadeAfterSaved: false, toastRefused };
  }
  const wasVisible = visible === "saving" || visible === "unsaved" || visible === "blocked";
  if (!wasVisible || toastRefused) return { show: "none", fadeAfterSaved: false, toastRefused };
  return { show: "saved", fadeAfterSaved: true, toastRefused };
}

const seen = new WeakMap<object, number>();

export function refusalsSeen(client: object): number {
  return seen.get(client) ?? 0;
}

export function markRefusalsSeen(client: object, count: number) {
  seen.set(client, Math.max(count, seen.get(client) ?? 0));
}
