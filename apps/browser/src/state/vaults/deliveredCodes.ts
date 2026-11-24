import { create } from "zustand";
import { deliveredCodes, onDeliveredCodesChanged, openFullDiskAccess, setDeliveredCodes, setDeliveredCodesWatching, type DeliveredCodeAccess, type DeliveredCodes } from "../../platform/vaults";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { useBrowser } from "../browser/store";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { noteDeliveredCodesToggled } from "../telemetry/vaultCounts";
import { forgetVaultCode, primeVaultCodes } from "./codes";
import { deliveredItem, liveDelivered, nextExpiry, type DeliveredItem } from "./deliveredCodesModel";

type DeliveredState = { access: DeliveredCodeAccess; items: DeliveredItem[] };

const NONE: DeliveredItem[] = [];

export const useDeliveredCodes = create<DeliveredState>()(() => ({ access: "off", items: NONE }));

export const currentDeliveredItems = () => useDeliveredCodes.getState().items;

let expiry: ReturnType<typeof setTimeout> | null = null;

function scheduleExpiry(at: number | null) {
  if (expiry) clearTimeout(expiry);
  expiry = at === null ? null : setTimeout(dropExpired, Math.max(0, at - Date.now()));
}

function dropExpired() {
  expiry = null;
  const { access, items } = useDeliveredCodes.getState();
  adoptDelivered({ access, codes: items.map((i) => i.delivered) });
}

let adopting = 0;

export function adoptDelivered(state: unknown): Promise<void> {
  const asked = ++adopting;
  const { access, codes } = liveDelivered(state, Date.now());
  const before = useDeliveredCodes.getState();
  const kept = new Map(before.items.map((i) => [i.id, i]));
  const items = codes.length ? codes.map((c) => (sameCode(kept.get(c.id), c) ? kept.get(c.id)! : deliveredItem(c))) : NONE;
  const commit = () => {
    if (asked !== adopting) return;
    const now = useDeliveredCodes.getState();
    const ids = new Set(items.map((i) => i.id));
    for (const gone of now.items) if (!ids.has(gone.id)) forgetVaultCode(gone);
    scheduleExpiry(nextExpiry(codes));
    const same = items.length === now.items.length && items.every((item, i) => item === now.items[i]);
    if (access !== now.access || !same) useDeliveredCodes.setState({ access, items: same ? now.items : items });
  };
  const fresh = items.filter((item) => kept.get(item.id) !== item);
  if (!fresh.length) return Promise.resolve(commit());
  return primeVaultCodes(fresh).then(commit);
}

const sameCode = (item: DeliveredItem | undefined, code: DeliveredCodes["codes"][number]) =>
  !!item && item.delivered.receivedAt === code.receivedAt && item.delivered.expiresAt === code.expiresAt && item.delivered.site === code.site && item.delivered.sender === code.sender && item.delivered.bound === code.bound;

type WantedSettings = { vaultSuggestDeliveredCodes: boolean; vaultSuggestCodes: boolean };
const wantedBy = (s: WantedSettings) => PLATFORM_FEATURES.deliveredCodes && s.vaultSuggestDeliveredCodes && s.vaultSuggestCodes;
const wanted = () => wantedBy(useBrowser.getState().settings);

let asking: Promise<void> | null = null;

export function refreshDeliveredCodes(): Promise<void> {
  if (!wanted()) return Promise.resolve();
  asking ??= deliveredCodes()
    .then(adoptDelivered, () => undefined)
    .finally(() => {
      asking = null;
    });
  return asking;
}

export const openPrivacySettings = () => void openFullDiskAccess().catch(() => undefined);

async function turnDelivered(enabled: boolean, toggled: { consent: ConsentToken | null } | null) {
  const state = await setDeliveredCodes(enabled).catch(() => null);
  if (!state) return;
  await adoptDelivered(state);
  if (toggled) noteDeliveredCodesToggled(useDeliveredCodes.getState().access, toggled.consent);
}

let started = false;
let codeFieldOpen = false;
let watchingTold = false;

function tellWatching() {
  const watching = codeFieldOpen && wanted();
  if (watching === watchingTold) return;
  watchingTold = watching;
  void setDeliveredCodesWatching(watching).then(adoptDelivered, () => undefined);
}

export function noteCodeFieldOpen(open: boolean) {
  codeFieldOpen = open;
  if (started) tellWatching();
}

export function startDeliveredCodes() {
  if (started || !PLATFORM_FEATURES.deliveredCodes) return;
  started = true;
  onDeliveredCodesChanged((state) => void adoptDelivered(state));
  useBrowser.subscribeTo(["settings"], (s, prev) => {
    const now = wantedBy(s.settings);
    if (now === wantedBy(prev.settings)) return;
    void turnDelivered(now, { consent: consentToken() });
    tellWatching();
  });
  void turnDelivered(wanted(), null);
}
