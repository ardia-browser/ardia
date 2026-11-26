type OutsidePresses = {
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  inside: (node: EventTarget | null) => boolean;
  menuShown: () => boolean;
  ignorePress?: (event: Event) => boolean;
  onOutsidePress: (timestamp: number) => void;
};

export function watchOutsidePresses({ target, inside, menuShown, ignorePress, onOutsidePress }: OutsidePresses): () => void {
  const down = (event: Event) => {
    if (menuShown() || ignorePress?.(event)) return;
    if (!inside(event.target)) onOutsidePress(event.timeStamp);
  };
  target.addEventListener("pointerdown", down, true);
  return () => target.removeEventListener("pointerdown", down, true);
}
