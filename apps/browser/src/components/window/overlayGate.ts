import { useEffect, useLayoutEffect, useRef } from "react";
import type { PageState } from "../../state/tabs/pageState";
import { consentToken, type ConsentToken } from "../../state/telemetry/client";
import { notePageOverlay } from "../../state/telemetry/usage";

export const OVERLAY = {
  find: 1 << 0,
  status: 1 << 1,
  sadTab: 1 << 2,
  permission: 1 << 3,
  password: 1 << 4,
  autofill: 1 << 5,
  verificationCode: 1 << 6,
  newTabNotice: 1 << 7,
  externalApp: 1 << 8,
  engineOffer: 1 << 9,
  sharePicker: 1 << 10,
  deviceChooser: 1 << 11,
  castPicker: 1 << 12,
  historyMenu: 1 << 13,
  selection: 1 << 14,
  loading: 1 << 15,
  control: 1 << 16,
} as const;

export type Overlay = keyof typeof OVERLAY;

export const BEHIND_NEW_TAB = OVERLAY.permission | OVERLAY.externalApp | OVERLAY.engineOffer | OVERLAY.deviceChooser | OVERLAY.loading;

export const pageOverlays = (p: PageState): number =>
  (p.status ? OVERLAY.status : 0) |
  (p.crashed || p.unresponsive ? OVERLAY.sadTab : 0) |
  (p.permission ? OVERLAY.permission : 0) |
  (p.passwordPrompt ? OVERLAY.password : 0) |
  (p.autofillPrompt ? OVERLAY.autofill : 0) |
  (p.verificationCode ? OVERLAY.verificationCode : 0) |
  (p.externalApp ? OVERLAY.externalApp : 0);

export const overlayBits = (on: Partial<Record<Overlay, boolean>>): number => {
  let bits = 0;
  for (const key in on) if (on[key as Overlay]) bits |= OVERLAY[key as Overlay];
  return bits;
};

export const overlayCount = (bits: number): number => {
  let count = 0;
  for (let rest = bits; rest; rest &= rest - 1) count++;
  return count;
};

type ShownOverlays = { previous: number; atShow: number; opened: number };

export function nextShownOverlays(was: ShownOverlays | null, shown: number): ShownOverlays {
  if (!was) return { previous: shown, atShow: overlayCount(shown), opened: 0 };
  return { previous: shown, atShow: 0, opened: overlayCount(shown & ~was.previous) };
}

type KeptOverlays = { has: (overlay: Overlay) => boolean; entersLater: (overlay: Overlay) => boolean };

export function useKeptOverlays(on: number, shown: number): KeptOverlays {
  const atShow = useRef(on).current;
  const committed = useRef(0);
  const bits = committed.current | on;
  useLayoutEffect(() => {
    committed.current = bits;
  }, [bits]);
  useShownOverlaysCount(shown);
  return {
    has: (overlay) => (bits & OVERLAY[overlay]) !== 0,
    entersLater: (overlay) => (atShow & OVERLAY[overlay]) === 0,
  };
}

const noteShownOverlays = (atShow: number, opened: number, consent: ConsentToken | null) => {
  for (let i = 0; i < atShow; i++) notePageOverlay("paneOverlayAtShow", consent);
  for (let i = 0; i < opened; i++) notePageOverlay("paneOverlayOpened", consent);
};

export function useShownOverlaysCount(shown: number, note: typeof noteShownOverlays = noteShownOverlays) {
  const committed = useRef<ShownOverlays | null>(null);
  const consent = consentToken();
  useEffect(() => {
    if (committed.current?.previous === shown) return;
    const next = nextShownOverlays(committed.current, shown);
    committed.current = next;
    if (next.atShow || next.opened) note(next.atShow, next.opened, consent);
  }, [shown]);
}

export function useKeptWhile(on: boolean, alive: boolean): boolean {
  const committed = useRef(false);
  const kept = alive && (committed.current || on);
  useLayoutEffect(() => {
    committed.current = kept;
  }, [kept]);
  return kept;
}

type EligibleGate = { mounted: boolean; enter: boolean; armed: boolean };

const CLOSED_GATE: EligibleGate = { mounted: false, enter: false, armed: false };

function nextEligibleGate(gate: EligibleGate, on: boolean, eligible: boolean): EligibleGate {
  if (!eligible) return CLOSED_GATE;
  if (gate.mounted) return gate;
  if (on) return { mounted: true, enter: gate.armed, armed: gate.armed };
  return gate.armed ? gate : { ...gate, armed: true };
}

export function useEligibleGate(on: boolean, eligible: boolean): { mounted: boolean; enter: boolean } {
  const committed = useRef(CLOSED_GATE);
  const gate = nextEligibleGate(committed.current, on, eligible);
  useLayoutEffect(() => {
    committed.current = gate;
  });
  return { mounted: gate.mounted, enter: gate.enter };
}
