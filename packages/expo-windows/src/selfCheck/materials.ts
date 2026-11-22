import { createElement, isValidElement } from "react";
import { requireNativeModule } from "../modules";
import { appDarkNow } from "../views/appearance";
import { windowBackdropColors } from "../views/backdrop";
import { gradientColors } from "../views/Bands";
import { gradientFill } from "../views/gradientFill";
import type { Rgba } from "../views/color";
import { bubblePath, NativeMaterialBlur, NativeMaterialGradient, NativeMaterialGrain, NativeWindowMaterial, type GrainTexture, type MaterialsNative } from "../views/nativeMaterials";
import { viewNamed } from "../views/registry";
import { Surface } from "../views/Surface";
import { expectEqual, expectTrue, type Check } from "./check";
import { holdOnStage, renderOnStage } from "./stage";

const materials = () => requireNativeModule<MaterialsNative>("ArdiaMaterials");

const WINDOW_MATERIALS = ["micaAlt", "mica", "acrylic"];
const MAC_TILE_ALPHA_SUMS: Record<string, number> = { grain: 287662, sand: 1429150, denim: 653735, tweed: 1227414 };
const GRAIN_PATH_DEADLINE_MS = 3000;
const STAGED_GRAIN_TEXTURE = "denim";
const OVERSIZED_HASH_CELL = 16;
const LARGEST_HASH_TILE_PIXELS = 1024;
const UNUSED_HASH_CELL = 2;
const UNUSED_HASH_TILE = "hash@512";
let stagedGrainViews = 0;
const VIEWS_WITH_MATERIALS = ["ArdiaVisualEffect", "ArdiaGlassEffect", "ArdiaPopoverBubble", "ArdiaWindowBackdrop", "ArdiaThemeSwatch"];
const MATERIAL_PROPS: Record<string, Record<string, unknown>> = {
  ArdiaVisualEffect: { material: "popover", cornerRadius: 12 },
  ArdiaGlassEffect: { cornerRadius: 10, glassStyle: "regular", tint: "#FF000040" },
  ArdiaPopoverBubble: { material: "menu", arrowEdge: "top", arrowX: 40, cornerRadius: 12 },
  ArdiaWindowBackdrop: { vibrancy: true, colors: ["#000000", "#FFFFFF"], themeColors: [0.1, 0.2, 0.3, 1, 0.4, 0.5, 0.6, 1, 0.9, 0.2, 0.1, 1], themeBaseAlpha: 0.3 },
  ArdiaThemeSwatch: { colors: [0.1, 0.2, 0.3, 1, 0.4, 0.5, 0.6, 1], angle: 135 },
};

const isComponent = (value: unknown) => typeof value === "function" || typeof value === "string" || (typeof value === "object" && value !== null && "$$typeof" in value);

function expectPath(answer: unknown, allowed: string[], what: string) {
  expectTrue(answer && typeof answer === "object", `${what}: no answer`);
  const { path, reason } = answer as { path?: unknown; reason?: unknown };
  expectTrue(typeof path === "string" && allowed.includes(path), `${what}: path ${JSON.stringify(path)} is not one of ${allowed.join(", ")}`);
  expectTrue(typeof reason === "string", `${what}: reason is not a string`);
  console.info(`[ardia windows] materials: ${what} took ${path}${reason ? ` (${reason})` : ""}`);
}

const settled = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !(await condition())) await settled(20);
  return await condition();
}

async function stagedGrain(texture: GrainTexture, cellSize?: number) {
  const requestId = `self-check-grain-${Date.now()}-${++stagedGrainViews}`;
  const release = await holdOnStage(
    createElement(NativeMaterialGrain, { pointerEvents: "none", texture, amount: 0.5, cellSize, requestId, style: { width: 200, height: 40 } }),
    "ArdiaMaterialGrain",
  );
  const reported = await until(() => materials().grainPath(requestId).path !== "", GRAIN_PATH_DEADLINE_MS);
  const last = () => materials().grainPath(requestId);
  if (!reported) release();
  expectTrue(reported, `the grain view ${requestId} reported nothing within ${GRAIN_PATH_DEADLINE_MS} ms: ${JSON.stringify(last())}`);
  return { release, last };
}

const keeps = async (tile: string) => (await materials().keptGrainTiles()).some((kept) => kept.startsWith(`${tile} `));

const linear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4));

function luminanceOver(color: Rgba, under: number): number {
  const [r, g, b] = [color[0], color[1], color[2]].map((channel) => channel * color[3] + under * (1 - color[3]));
  return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);
}

const rgba = (color: Rgba) => `rgba(${color.map((channel, i) => (i < 3 ? Math.round(channel * 255) : +channel.toFixed(2))).join(",")})`;

export const checks: Check[] = [
  {
    name: "materials: the dark window backdrop is darker than the light one",
    run() {
      for (const baseAlpha of [undefined, 0, 0.3, 0.8]) {
        const dark = windowBackdropColors(true, baseAlpha);
        const light = windowBackdropColors(false, baseAlpha);
        const what = baseAlpha === undefined ? "default theme" : `theme base alpha ${baseAlpha}`;
        console.info(`[ardia windows] materials: ${what} dark tint=${rgba(dark.tint)} fallback=${rgba(dark.fallback)}; light tint=${rgba(light.tint)} fallback=${rgba(light.fallback)}`);
        expectTrue(luminanceOver(dark.fallback, 0.5) < luminanceOver(light.fallback, 0.5), `${what}: dark fallback ${rgba(dark.fallback)} is not darker than light ${rgba(light.fallback)}`);
        for (const under of [0.2, 0.5, 0.8]) {
          expectTrue(luminanceOver(dark.tint, under) <= luminanceOver(light.tint, under), `${what}: dark tint ${rgba(dark.tint)} is not darker than light ${rgba(light.tint)} over grey ${under}`);
        }
        expectTrue(dark.fallback[3] === 1 && light.fallback[3] === 1, `${what}: the flat fallback is not opaque`);
      }
      const defaults = { dark: windowBackdropColors(true), light: windowBackdropColors(false) };
      expectTrue(luminanceOver(defaults.dark.tint, 0.5) < luminanceOver(defaults.light.tint, 0.5), "default theme: dark tint is not strictly darker");
      console.info(`[ardia windows] materials: the app appearance as the views see it is ${JSON.stringify(appDarkNow())}`);
    },
  },
  {
    name: "materials: the module answers which paths this machine has",
    run() {
      const answer = materials().capabilities() as unknown;
      expectTrue(answer && typeof answer === "object" && !(answer instanceof Promise), "capabilities() did not answer synchronously");
      const caps = answer as Record<string, unknown>;
      for (const key of ["systemBackdrop", "systemBackdropSupported", "inWindowBlur", "gradient", "grain", "background"]) expectTrue(typeof caps[key] === "boolean", `${key} is not a boolean`);
      const build = caps.build;
      expectTrue(typeof build === "number" && Number.isInteger(build) && build > 0, `build ${JSON.stringify(build)} is not a Windows build number`);
      expectEqual(caps.systemBackdropSupported, build >= 22621, "system backdrop support follows the build");
      expectEqual(caps.systemBackdrop, caps.systemBackdropSupported === true && caps.background !== true, "system backdrop is off in a background instance");
      console.info(`[ardia windows] materials: ${JSON.stringify(caps)}`);
    },
  },
  {
    name: "materials: every window material on the self-check window resolves",
    async run() {
      const caps = materials().capabilities();
      for (const material of WINDOW_MATERIALS) {
        const answer = await materials().applyWindowMaterial("", material);
        expectPath(answer, caps.systemBackdrop ? [material, "flat"] : ["flat"], `window material ${material}`);
        const cleared = await materials().clearWindowMaterial("");
        expectEqual(cleared, answer.path !== "flat", `clearing ${material}`);
      }
      expectPath(await materials().applyWindowMaterial("no-such-window-id", "mica"), ["flat"], "window material on a missing window");
      expectEqual(await materials().clearWindowMaterial("no-such-window-id"), false, "clearing a missing window");
    },
  },
  {
    name: "materials: blur and gradient brushes build on the UI thread",
    async run() {
      const caps = materials().capabilities();
      const blur = await materials().probeBlur();
      expectPath(blur, ["blur", "flat"], "in-window blur");
      expectTrue(["saturated", "tinted", "plain", "flat"].includes(String(blur.step)), `in-window blur step ${JSON.stringify(blur.step)} is unknown`);
      console.info(`[ardia windows] materials: in-window blur reached step ${blur.step}; in-window blur available: ${caps.inWindowBlur}`);
      expectPath(await materials().probeGradient(), ["gradient"], "gradient");
    },
  },
  {
    name: "materials: a Surface with fill colours and a fade draws through the native gradient's mask",
    async run() {
      const fill = { fillColors: ["#ff000000", "#ff0000ff"], fillStops: [0, 1], fade: [1, 0], fadeStops: [0, 1] };
      const filled = gradientFill(fill);
      expectTrue(!!filled && filled.places?.length === 2 && filled.fade?.length === 2, `gradient fill read as ${JSON.stringify(filled)}`);
      await renderOnStage(createElement(Surface, { ...fill, style: { width: 120, height: 30 } }), "a gradient Surface with a fade");
    },
  },
  {
    name: "materials: grain tiles are the Mac's and draw pixel for pixel",
    async run() {
      for (const texture of [...Object.keys(MAC_TILE_ALPHA_SUMS), "hash"]) {
        const probe = await materials().probeGrain(texture);
        expectPath(probe, ["tiled", "none"], `grain ${texture}`);
        expectEqual(probe.path, "tiled", `grain ${texture} drew no tile (${probe.reason})`);
        const mac = MAC_TILE_ALPHA_SUMS[texture];
        if (mac !== undefined) expectEqual(probe.tileAlphaSum, mac, `grain ${texture} tile alpha sum against the Mac's`);
        expectEqual(probe.drawnAlphaSum, probe.tileAlphaSum, `grain ${texture} alpha read back from its ${probe.pixels} px surface`);
        console.info(`[ardia windows] materials: grain ${texture} ${probe.pixels} px tile, alpha sum ${probe.tileAlphaSum}, read back ${probe.drawnAlphaSum}`);
      }
    },
  },
  {
    name: "materials: the grain view mounts and reports its own path",
    async run() {
      const staged = await stagedGrain(STAGED_GRAIN_TEXTURE);
      try {
        const grain = materials().capabilities().grain;
        expectEqual(staged.last().step, STAGED_GRAIN_TEXTURE, "the staged grain view's texture");
        expectPath(staged.last(), grain ? ["tiled"] : ["none"], "mounted grain view");
        expectEqual(staged.last().brushed, grain, "the mounted grain view's brush");
      } finally {
        staged.release();
      }
    },
  },
  {
    name: "materials: a replaced Direct3D device keeps the grain tiles and redraws them",
    async run() {
      const grainAtStart = materials().capabilities().grain;
      const probe = await materials().probeGrainRecovery(STAGED_GRAIN_TEXTURE);
      if (!grainAtStart) {
        expectPath(probe, ["none"], "grain recovery without grain");
        return;
      }
      expectPath(probe, ["redrawn"], `grain recovery (grain is ${materials().capabilities().grain ? "still" : "no longer"} available after it)`);
      expectTrue(probe.sameSurface, "the tile's surface was replaced instead of kept, so mounted views would keep a dead brush");
      expectEqual(probe.after, probe.before, `the ${STAGED_GRAIN_TEXTURE} tile read back after the new device`);
      expectEqual(probe.before, MAC_TILE_ALPHA_SUMS[STAGED_GRAIN_TEXTURE], `the ${STAGED_GRAIN_TEXTURE} tile against the Mac's`);
      console.info(`[ardia windows] materials: grain recovery kept the surface and read back ${probe.after} after a new device`);
    },
  },
  {
    name: "materials: the hash grain's cell size is clamped, so its tile stays bounded",
    async run() {
      const staged = await stagedGrain("hash", OVERSIZED_HASH_CELL);
      try {
        if (!materials().capabilities().grain) {
          expectPath(staged.last(), ["none"], "an oversized hash cell without grain");
          return;
        }
        expectPath(staged.last(), ["tiled"], "an oversized hash cell");
        expectTrue(staged.last().reason.startsWith(`${LARGEST_HASH_TILE_PIXELS} px tile`), `a ${OVERSIZED_HASH_CELL} px hash cell drew ${staged.last().reason}`);
      } finally {
        staged.release();
      }
    },
  },
  {
    name: "materials: a tile size no view uses any more is dropped",
    async run() {
      const staged = await stagedGrain("hash", UNUSED_HASH_CELL);
      let released = false;
      try {
        if (!materials().capabilities().grain) return;
        expectTrue(await keeps(UNUSED_HASH_TILE), `the ${UNUSED_HASH_TILE} tile is not kept while its view shows: ${JSON.stringify(await materials().keptGrainTiles())}`);
        staged.release();
        released = true;
        const dropped = await until(async () => !(await keeps(UNUSED_HASH_TILE)), GRAIN_PATH_DEADLINE_MS);
        expectTrue(dropped, `the ${UNUSED_HASH_TILE} tile is still kept after its only view went: ${JSON.stringify(await materials().keptGrainTiles())}`);
      } finally {
        if (!released) staged.release();
      }
    },
  },
  {
    name: "materials: a grain failure clears the views already drawing grain",
    async run() {
      const staged = await stagedGrain(STAGED_GRAIN_TEXTURE);
      try {
        if (!materials().capabilities().grain) return;
        expectPath(staged.last(), ["tiled"], "the view before the failure");
        expectTrue(staged.last().brushed, "the view had no brush before the failure");
        expectTrue(await materials().failGrainForCheck(), "the grain did not report its failure");
        const cleared = await until(() => staged.last().path === "none", GRAIN_PATH_DEADLINE_MS);
        expectTrue(cleared, `the mounted view never heard of the failure: ${JSON.stringify(staged.last())}`);
        expectEqual(staged.last().brushed, false, "the mounted view's brush after the failure");
        expectEqual(materials().capabilities().grain, false, "grain after the failure");
      } finally {
        staged.release();
      }
    },
  },
  {
    name: "materials: native view names resolve to components",
    run() {
      for (const [name, view] of [
        ["ArdiaWindowMaterial", NativeWindowMaterial],
        ["ArdiaMaterialBlur", NativeMaterialBlur],
        ["ArdiaMaterialGradient", NativeMaterialGradient],
        ["ArdiaMaterialGrain", NativeMaterialGrain],
      ] as const) {
        expectTrue(isComponent(view), `${name} is not a host component`);
      }
      for (const name of VIEWS_WITH_MATERIALS) {
        const view = viewNamed<Record<string, unknown>>(name);
        expectTrue(isComponent(view), `${name} is not a component`);
        expectTrue(isValidElement(createElement(view, MATERIAL_PROPS[name] ?? {})), `${name} made no element`);
      }
    },
  },
  {
    name: "materials: bubble outlines and gradient stops are well formed",
    run() {
      const plain = bubblePath(200, 120, 12, "none", 0, 20, 9);
      expectTrue(plain.startsWith("M ") && plain.endsWith("Z") && !plain.includes("Q"), `plain bubble: ${plain}`);
      const arrow = bubblePath(200, 120, 12, "top", 100, 20, 9);
      expectEqual((arrow.match(/Q/g) ?? []).length, 3, "arrow joints");
      const below = bubblePath(200, 120, 12, "bottom", 100, 20, 9);
      expectTrue(/Q 100 120 /.test(below), `bottom arrow tip is not at the bottom edge: ${below}`);
      expectEqual(bubblePath(0, 0, 12, "top", 0, 20, 9), "", "empty bubble");
      expectEqual(gradientColors([], 16), [], "no stops");
      expectEqual(gradientColors([[1, 0, 0, 1]], 16), [1, 0, 0, 1], "one stop");
      const colors = gradientColors([[0, 0, 0, 1], [1, 1, 1, 1]], 16);
      expectEqual(colors.length, 64, "sixteen sampled stops");
      expectTrue(colors.every(Number.isFinite), "non-finite gradient stop");
    },
  },
];
