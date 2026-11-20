import { selfChecks } from "../../state/app/selfCheck";
import { toggleSidebar } from "../../state/windows/actions";
import { closeCheckPage, openCheckPage, windowIsEmpty } from "../../state/windows/dockCheckPage";
import { animating, currentValue } from "../ui/motion";
import type { usePeek } from "./usePeek";

type SidebarDockLayer = { opacity: unknown; transform: { translateX: unknown }[] };

type SidebarDockProbe = { peek: ReturnType<typeof usePeek>; open: boolean; moving: boolean; fullscreen: boolean; layer: SidebarDockLayer };

type DockMoment = { label: string; ready(closingMs: number, slide: number): boolean };

const DOCK_MOMENTS: DockMoment[] = [
  ...[0, 40, 80, 120].map((ms) => ({ label: `${ms} ms into the closing slide`, ready: (closingMs: number) => closingMs >= ms })),
  ...[0.7, 0.3].map((at) => ({ label: `at slide ${at}`, ready: (_closingMs: number, slide: number) => slide <= at })),
];
const POLL_MS = 16;
const SETTLE_MS = 4000;
const START_MOVING_MS = 300;
const STRAY_WRITES_MS = 250;

const probes = new Map<string, SidebarDockProbe>();
let numericLayers = 0;

const numeric = (layer: SidebarDockLayer) => typeof layer.opacity === "number" || layer.transform.some((t) => typeof t.translateX === "number");

export function noteSidebarDock(windowId: string, probe: SidebarDockProbe) {
  if (numeric(probe.layer)) numericLayers += 1;
  probes.set(windowId, probe);
}

export const forgetSidebarDock = (windowId: string) => void probes.delete(windowId);

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function seen(test: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) return false;
    await pause(POLL_MS);
  }
  return true;
}

async function until(what: string, test: () => boolean, ms = SETTLE_MS) {
  if (!(await seen(test, ms))) throw new Error(`timed out waiting for ${what}`);
}

const nodeValue = (node: unknown) => (node as { __getValue?: () => unknown } | null)?.__getValue?.();

function offIdentity(probe: SidebarDockProbe) {
  const opacity = nodeValue(probe.layer.opacity);
  const offset = nodeValue(probe.layer.transform[0]?.translateX);
  const slide = currentValue(probe.peek.slide);
  const sliding = animating(probe.peek.slide);
  if (opacity === 1 && offset === 0 && slide === 0 && !sliding) return null;
  return `opacity ${String(opacity)}, offset ${String(offset)}, slide ${slide}${sliding ? ", still animating" : ""}`;
}

function probeFor(windowId: string) {
  const probe = probes.get(windowId);
  if (!probe) throw new Error("the sidebar dock went away");
  return probe;
}

async function setDocked(windowId: string, open: boolean) {
  if (probeFor(windowId).open === open) return;
  toggleSidebar(windowId);
  await until(open ? "the sidebar to show" : "the sidebar to hide", () => probeFor(windowId).open === open);
  await seen(() => probeFor(windowId).moving, START_MOVING_MS);
  await until("the dock to stop moving", () => !probeFor(windowId).moving);
}

async function dockMidClose(windowId: string, moment: DockMoment) {
  const probe = () => probeFor(windowId);
  await setDocked(windowId, false);
  probe().peek.show();
  await until("the peek to slide out", () => probe().peek.live && currentValue(probe().peek.slide) === 1 && !animating(probe().peek.slide));
  probe().peek.hide();
  await until("the closing slide to start", () => currentValue(probe().peek.slide) < 1);
  const closing = Date.now();
  await until(`the moment to dock ${moment.label}`, () => moment.ready(Date.now() - closing, currentValue(probe().peek.slide)));
  const slideAtDock = currentValue(probe().peek.slide);
  await setDocked(windowId, true);
  await until("the peek to settle", () => !probe().peek.live && !probe().peek.leaving && !animating(probe().peek.slide));
  await pause(STRAY_WRITES_MS);
  const off = offIdentity(probe());
  if (off) {
    console.info(`[ardia windows] self-check note: sidebar peek layer rests off identity after docking ${moment.label}: ${off}`);
    throw new Error(`the peek layer rests off identity: ${off}`);
  }
  return slideAtDock;
}

async function checkSidebarPeek() {
  const windowId = probes.keys().next().value;
  if (windowId === undefined) {
    console.info("[ardia windows] self-check note: sidebar peek skipped, no window shows tabs in the sidebar");
    return;
  }
  if (probeFor(windowId).fullscreen) {
    console.info("[ardia windows] self-check note: sidebar peek skipped, the window is full screen");
    return;
  }
  const wasOpen = probeFor(windowId).open;
  numericLayers = 0;
  const slides: number[] = [];
  const pageTab = windowIsEmpty(windowId) ? openCheckPage(windowId) : null;
  try {
    await until("a page to open in the window", () => !windowIsEmpty(windowId));
    await setDocked(windowId, true);
    for (const moment of DOCK_MOMENTS) slides.push(await dockMidClose(windowId, moment));
  } finally {
    try {
      if (probes.has(windowId)) await setDocked(windowId, wasOpen);
    } finally {
      if (pageTab) closeCheckPage(pageTab);
    }
  }
  const midClose = slides.filter((slide) => slide > 0 && slide < 1).length;
  console.info(`[ardia windows] self-check note: sidebar peek, ${slides.length} cycles, ${midClose} docked mid-close, slide at dock ${slides.map((slide) => slide.toFixed(2)).join(" ")}`);
  if (midClose === 0) throw new Error(`no cycle docked while the peek was still closing (slide at dock ${slides.join(" ")})`);
  if (numericLayers > 0) throw new Error(`the peek layer took a plain number instead of its gated value in ${numericLayers} renders`);
}

selfChecks.register({ name: "sidebar peek layer rests at identity after docking mid-close", run: checkSidebarPeek });
