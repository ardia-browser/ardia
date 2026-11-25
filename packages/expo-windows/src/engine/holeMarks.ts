let marking = false;

export function markHoles(on: boolean) {
  marking = on;
}

export function holeMark(text: () => string) {
  if (marking) console.info(`[ardia windows] hole ${text()}`);
}

export const boxText = (box: { x: number; y: number; width: number; height: number }) => `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`;
