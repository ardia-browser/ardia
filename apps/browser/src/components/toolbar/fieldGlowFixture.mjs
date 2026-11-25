const { fieldLoadPlates, frontOf } = await import("./fieldLoadDrive.ts");
const { FIELD_LOAD } = await import("./tokens.ts");
const { parseColor, toHex } = await import("../../lib/color.ts");
const { colorRoles, ink } = await import("../ui/tokens.ts");

export const FIXTURE_CASES = [
  { color: colorRoles.dark.accent, width: 400, height: 30 },
  { color: ink.neutralGrey, width: 120, height: 22 },
  { color: colorRoles.light.accent, width: 40, height: 30 },
];

const plateOut = (rgba, plate) => {
  const [r, g, b, a] = rgba;
  return {
    colors: plate.stops.map(([, alpha]) => toHex([r, g, b, a * alpha * 255])),
    stops: plate.stops.map(([at]) => at),
    fade: plate.fade.map(([, alpha]) => alpha),
    fadeStops: plate.fade.map(([at]) => at),
    extra: plate.extra,
  };
};

export const clampOf = (progress, width) => Math.max(FIELD_LOAD.floor, Math.min(progress, 1 - frontOf(width).tail / width));

export function fieldGlowFixture() {
  return FIXTURE_CASES.map(({ color, width, height }) => {
    const rgba = parseColor(color);
    const plates = fieldLoadPlates(width, height);
    return {
      color,
      rgba,
      width,
      height,
      tail: plateOut(rgba, plates.tail),
      cap: plateOut(rgba, plates.cap),
      comet: plateOut(rgba, plates.comet),
      clamps: [0, 0.05, 0.3, 0.7, 0.95, 1].map((progress) => [progress, clampOf(progress, width)]),
    };
  });
}
