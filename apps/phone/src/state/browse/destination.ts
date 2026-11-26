import { makeMutable, runOnJS, runOnUI } from "react-native-reanimated";
import { create } from "zustand";
import { labTrace } from "../../platform/lab";
import { pageNavigation, usePages } from "../pages/store";
import { currentTabs } from "../tabs/store";
import { findTab } from "../tabs/tabsState";
import { pageBarPreviewShown, pageBarShown, previewPageBar } from "./deckPull";
import { commitBarAction, holdBarAction, takeBarAction, useBrowse, whenPageCoverHidden, type BarAction } from "./store";

export const destination = {
  id: makeMutable(""),
  turn: makeMutable(0),
  cover: makeMutable({ id: "", name: "" }),
  pending: makeMutable(0),
  bound: makeMutable({ cover: "", turn: 0 }),
};

export type DestinationAddress = { host: string; spoken: string; isPrivate: boolean; insecure: boolean; fill: string };

export const destinationAddresses = makeMutable<Record<string, DestinationAddress>>({});

export const DESTINATION_COVER_ID = "destinationCover";

export const DESTINATION_HELD_MS = 4_000;

export function liftDestination(id: string) {
  "worklet";
  destination.turn.value += 1;
  destination.pending.value = destination.turn.value;
  destination.id.value = id;
  pageBarShown.value = 1;
  pageBarPreviewShown.value = 1;
}

export function destinationLiftPending(): boolean {
  "worklet";
  return destination.id.value !== "" && destination.pending.value !== 0 && destination.pending.value === destination.turn.value;
}

function bindArrival(id: string, cover: string) {
  "worklet";
  if (destination.id.value !== id) liftDestination(id);
  destination.pending.value = 0;
  destination.bound.value = { cover, turn: destination.turn.value };
}

export function destinationFaceShows(faceId: string, liftedId: string, barShown: number): boolean {
  "worklet";
  return faceId !== "" && faceId === liftedId && barShown > 0;
}

export function destinationHeldFill(liftedId: string, barShown: number, table: Record<string, DestinationAddress>): string | null {
  "worklet";
  return liftedId !== "" && barShown > 0 ? (table[liftedId]?.fill ?? null) : null;
}

export function destinationHeldUntil(liftedId: string, cover: { id: string; name: string }): string | null {
  "worklet";
  return liftedId !== "" && cover.id === liftedId && cover.name !== "" ? cover.name : null;
}

export function destinationLeafShows(liftedId: string, shownId: string, leafId: string | null, previewShown: number): boolean {
  "worklet";
  return previewShown > 0 && liftedId !== "" && liftedId !== shownId && leafId === liftedId;
}

export function destinationStandsIn(liftedId: string, shownId: string, previewShown: number): boolean {
  "worklet";
  return previewShown > 0 && liftedId !== "" && liftedId !== shownId;
}

type DestinationState = { prepared: string | null; arriving: string | null; cover: string | null; spent: Readonly<Record<string, number>> };

export const useDestination = create<DestinationState>()(() => ({ prepared: null, arriving: null, cover: null, spent: {} }));

const spentAfter = (spent: Readonly<Record<string, number>>, id: string | null) => (id === null ? spent : { ...spent, [id]: (spent[id] ?? 0) + 1 });

export const destinationFaceKey = (id: string, spent: Readonly<Record<string, number>>) => `${id}:${spent[id] ?? 0}`;

function spendFace(id: string) {
  useDestination.setState((now) => (now.arriving === id ? now : { spent: spentAfter(now.spent, id) }));
}

export type DestinationCard = { id: string; index: number };

const faceHolds = new Map<string, { count: number; index: number }>();

export const useDestinationFaces = create<{ cards: readonly DestinationCard[] }>()(() => ({ cards: [] }));

const publishFaces = () => {
  const cards = [...faceHolds].map(([id, hold]) => ({ id, index: hold.index }));
  const was = useDestinationFaces.getState().cards;
  if (was.length !== cards.length || was.some((card, at) => card.id !== cards[at]!.id || card.index !== cards[at]!.index)) useDestinationFaces.setState({ cards });
};

export function holdDestinationFace(id: string, index: number): () => void {
  faceHolds.set(id, { count: (faceHolds.get(id)?.count ?? 0) + 1, index });
  publishFaces();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const hold = faceHolds.get(id);
    if (!hold) return;
    if (hold.count > 1) faceHolds.set(id, { ...hold, count: hold.count - 1 });
    else faceHolds.delete(id);
    publishFaces();
  };
}

export const PARKED_FACE_REACH = 2;

export function destinationFaceIds(cards: readonly DestinationCard[], shownId: string, deckShown: boolean, prepared: string | null, arriving: string | null): readonly string[] {
  const shownAt = cards.find((card) => card.id === shownId)?.index ?? -1;
  const reachable = cards.filter((card) => deckShown || (shownAt >= 0 && card.index >= 0 && Math.abs(card.index - shownAt) <= PARKED_FACE_REACH)).map((card) => card.id);
  const extra = [prepared, arriving].filter((id, at, all): id is string => id !== null && !reachable.includes(id) && all.indexOf(id) === at);
  return extra.length === 0 ? reachable : [...reachable, ...extra];
}

export const deckScope = (turn: number) => `deck:${turn}`;

export function pressDestination(id: string) {
  previewPageBar(id);
  prepareDestination(id);
}

export function prepareDestination(id: string) {
  const now = useDestination.getState();
  if (now.arriving === id || (now.arriving === null && now.prepared === id)) return;
  if (now.arriving !== null) {
    stopWaiting();
    destination.cover.value = { id: "", name: "" };
  }
  useDestination.setState({ prepared: id, arriving: null, cover: null, spent: spentAfter(now.spent, now.arriving) });
}

let coverSeq = 0;
let stopWait: (() => void) | null = null;

const stopWaiting = () => {
  const stop = stopWait;
  stopWait = null;
  stop?.();
};

export const barFencedForDestination = (_shownId: string) => {
  if (useBrowse.getState().surface !== "deck") return false;
  const lifted = destination.id.value;
  return lifted !== "" && useDestination.getState().arriving !== lifted;
};

export function routeBarToDestination(shownId: string, action: BarAction): boolean {
  if (!barFencedForDestination(shownId)) return false;
  holdBarAction(destination.id.value, action, deckScope(destination.turn.value));
  return true;
}

export const takeDestinationAction = (id: string): BarAction | null => takeBarAction(deckScope(destination.turn.value), id);

export function arriveFromDeck(id: string, held: BarAction | null = null) {
  stopWaiting();
  if (held && currentTabs().selectedId === id) commitBarAction(id, held);
  coverSeq += 1;
  const cover = `${DESTINATION_COVER_ID}-${coverSeq}`;
  runOnUI(bindArrival)(id, cover);
  const replaced = useDestination.getState().arriving;
  useDestination.setState((now) => ({ prepared: id, arriving: id, cover, spent: replaced !== null && replaced !== id ? spentAfter(now.spent, replaced) : now.spent }));
  destination.cover.value = { id, name: cover };
  const failed = () => {
    if (pageNavigation(id)?.failure && useDestination.getState().cover === cover) releaseDestination(id);
  };
  const stopFailure = usePages.subscribe(failed);
  const wait = (): (() => void) =>
    whenPageCoverHidden(
      id,
      DESTINATION_HELD_MS,
      (reason) => {
        const now = useDestination.getState();
        if (now.arriving !== id || now.cover !== cover) return;
        if (reason === "lost" && findTab(currentTabs(), id) && currentTabs().selectedId === id && !pageNavigation(id)?.failure) {
          labTrace(`PAGELAB destination ${id} still undrawn after ${DESTINATION_HELD_MS} ms, its face stays and waits again`);
          const again = wait();
          stopWait = () => {
            stopFailure();
            again();
          };
          return;
        }
        stopFailure();
        releaseDestination(id);
      },
      cover,
    );
  const stopCover = wait();
  stopWait = () => {
    stopFailure();
    stopCover();
  };
}

export function releaseDestination(id: string | null = null) {
  const now = useDestination.getState();
  if (id !== null && now.prepared !== id && now.arriving !== id) return;
  if (id === null || now.arriving === id) stopWaiting();
  useDestination.setState({ prepared: null, arriving: null, cover: null });
  destination.cover.value = { id: "", name: "" };
  runOnUI((released: string | null, spent: string | null, cover: string | null) => {
    "worklet";
    const newerLift = cover !== null && (destination.bound.value.cover !== cover || destination.bound.value.turn !== destination.turn.value);
    if (!newerLift && (released === null || destination.id.value === released)) {
      destination.id.value = "";
      destination.pending.value = 0;
    }
    if (spent !== null) runOnJS(spendFace)(spent);
  })(id, now.arriving, now.arriving !== null ? now.cover : null);
}

export function dropPreparedDestination() {
  const now = useDestination.getState();
  if (now.arriving !== null) return;
  if (now.prepared !== null) useDestination.setState({ prepared: null });
  runOnUI(() => {
    "worklet";
    destination.id.value = "";
    destination.pending.value = 0;
  })();
}

export function destinationPageFailed(id: string) {
  const now = useDestination.getState();
  if (now.arriving === id || now.prepared === id) releaseDestination(id);
}

export const destinationCoverOf = (id: string) => {
  const { arriving, cover } = useDestination.getState();
  return arriving === id ? cover : null;
};

export const destinationCovers = (id: string) => useDestination.getState().arriving === id;

export const useDestinationCover = (id: string) => useDestination((s) => (s.arriving === id ? s.cover : null));

export function publishDestinationAddresses(addresses: Record<string, DestinationAddress>) {
  destinationAddresses.value = addresses;
}
