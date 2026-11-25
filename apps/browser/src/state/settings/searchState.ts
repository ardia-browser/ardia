import { create } from "zustand";
import { goToSettingsPane, newSettingsVisit, onTargetedSettingsOpen, shownSettingsProfile, type SettingsPane, type SettingsPlace, useSettingsNav } from "./settingsWindows";
import { settingsProfileFor } from "../extensions/store";
import { noteSettingsRevealMiss, noteSettingsSearch, noteSettingsSearchReveal } from "../telemetry/usage";
import { consentToken, type ConsentToken } from "../telemetry/choice";

type SearchUi = {
  query: string;
  selected: number;
  keyboardMove: number;
  focusRequest: number;
  reveal: RevealRequest | null;
  flash: { id: string; at: number } | null;
  revealedSections: string[];
  previewSection: string | null;
  previewing: boolean;
  shortcutsQuery: string;
};

type Target = { id: string; pane: SettingsPane; section: string };

export type RevealRequest = { id: string; at: number; token: number; target: SettingsPlace; consent: ConsentToken | null };

export const REVEAL_MEASURE_MS = 1000;

let revealTokens = 0;

const samePlace = (a: SettingsPlace, b: SettingsPlace) => a.pane === b.pane && a.profileId === b.profileId && a.detail === b.detail;

function requestReveal(id: string, consent: ConsentToken | null): { reveal: RevealRequest } {
  const { pane, profileId, detail } = useSettingsNav.getState();
  return { reveal: { id, at: Date.now(), token: ++revealTokens, target: { pane, profileId, detail }, consent } };
}

const MENU_COMMANDS: Target = { id: "shortcuts.menuCommands", pane: "shortcuts", section: "Keyboard" };

export const useSettingsSearch = create<SearchUi>()(() => ({
  query: "",
  selected: 0,
  keyboardMove: 0,
  focusRequest: 0,
  reveal: null,
  flash: null,
  revealedSections: [],
  previewSection: null,
  previewing: false,
  shortcutsQuery: "",
}));

const settingsSectionKey = (pane: SettingsPane, section: string) => `${pane}\u0000${section}`;

let emptyNoted = false;

export function setSettingsQuery(query: string) {
  const started = !useSettingsSearch.getState().query.trim() && !!query.trim();
  if (started) {
    emptyNoted = false;
    noteSettingsSearch("started");
  }
  useSettingsSearch.setState({ query, selected: 0, keyboardMove: 0, ...(query.trim() ? {} : { previewing: false }) });
}

export function dropSettingsSearch(consent: ConsentToken | null, why: "dropped" | "closed" = "dropped") {
  if (useSettingsSearch.getState().query.trim()) noteSettingsSearch(why, consent);
  useSettingsSearch.setState({ query: "", selected: 0, keyboardMove: 0, reveal: null, flash: null, previewSection: null, previewing: false });
}

onTargetedSettingsOpen((consent, reveal) => {
  dropSettingsSearch(consent);
  if (reveal) revealSettingRow(reveal, consent);
});

export const settingsSearchHost = () => () => dropSettingsSearch(consentToken(), "closed");

export function noteSettingsSearchEmpty() {
  if (emptyNoted) return;
  emptyNoted = true;
  noteSettingsSearch("empty");
}

export const keySearchConsent = (): ConsentToken | null => consentToken();

export const noteSettingsKeySearch = (consent: ConsentToken | null) => noteSettingsSearch("keys", consent);

export function noteShortcutsKeySearch(via: "typed" | "recorded", found: boolean, consent: ConsentToken | null) {
  noteSettingsSearch(via === "typed" ? "shortcutsTyped" : "shortcutsRecorded", consent);
  if (!found) noteSettingsSearch("shortcutsEmpty", consent);
}

export const focusSettingsSearch = () => useSettingsSearch.setState({ focusRequest: Date.now() });

export const currentSettingsSearch = () => useSettingsSearch.getState();

export const moveSettingsSelection = (step: number, count: number) =>
  useSettingsSearch.setState((s) => ({ selected: Math.max(0, Math.min(count - 1, s.selected + step)), keyboardMove: s.keyboardMove + 1 }));

export const selectSettingsResult = (index: number) => useSettingsSearch.setState({ selected: index });

export const revealSettingRow = (id: string, consent: ConsentToken | null) => useSettingsSearch.setState(requestReveal(id, consent));

useSettingsNav.subscribe((nav) => {
  const { reveal } = useSettingsSearch.getState();
  if (reveal && !samePlace(nav, reveal.target)) useSettingsSearch.setState({ reveal: null });
});

export const revealWanted = (request: RevealRequest, nav: SettingsPlace) => useSettingsSearch.getState().reveal?.token === request.token && samePlace(nav, request.target);

export const revealTargetShown = (shown: SettingsPlace | null, request: RevealRequest) => !!shown && samePlace(shown, request.target);

export function dropReveal(token: number) {
  if (useSettingsSearch.getState().reveal?.token === token) useSettingsSearch.setState({ reveal: null });
}

export function finishReveal(token: number, flashId: string, missed: boolean): boolean {
  const request = useSettingsSearch.getState().reveal;
  if (request?.token !== token) return false;
  if (missed) noteSettingsRevealMiss(request.consent);
  useSettingsSearch.setState({ reveal: null, flash: { id: flashId, at: Date.now() } });
  return true;
}

export type RevealAnchor = { measure(found: (y: number, height: number) => void, failed: () => void): void; still(): boolean };

const REVEAL_POLL_MS = 20;

export function runReveal(request: RevealRequest, flashId: string, locate: () => RevealAnchor | null, place: (y: number, height: number) => void): () => void {
  let active = true;
  let poll: ReturnType<typeof setTimeout> | null = null;
  let sawAnchor = false;
  const clearPoll = () => {
    if (poll !== null) {
      clearTimeout(poll);
      poll = null;
    }
  };
  const wanted = () => active && revealWanted(request, useSettingsNav.getState());
  const end = (found: boolean, flash = flashId) => {
    active = false;
    clearPoll();
    clearTimeout(deadline);
    finishReveal(request.token, flash, !found);
  };
  const deadline = setTimeout(() => {
    if (wanted()) end(false, sawAnchor ? flashId : "");
  }, REVEAL_MEASURE_MS);
  const attempt = () => {
    clearPoll();
    if (!wanted()) return;
    const anchor = locate();
    if (!anchor) {
      poll = setTimeout(attempt, REVEAL_POLL_MS);
      return;
    }
    sawAnchor = true;
    let settled = false;
    const watch = () => {
      poll = null;
      if (settled || !wanted()) return;
      if (!anchor.still()) {
        settled = true;
        attempt();
        return;
      }
      poll = setTimeout(watch, REVEAL_POLL_MS);
    };
    poll = setTimeout(watch, REVEAL_POLL_MS);
    anchor.measure(
      (y, height) => {
        if (settled || !wanted()) return;
        settled = true;
        clearPoll();
        if (!anchor.still()) return attempt();
        place(y, height);
        end(true);
      },
      () => {
        if (settled || !wanted()) return;
        settled = true;
        clearPoll();
        if (!anchor.still()) return attempt();
        end(false);
      },
    );
  };
  if (wanted()) attempt();
  else clearTimeout(deadline);
  return () => {
    active = false;
    clearPoll();
    clearTimeout(deadline);
  };
}

export function revealSetting(target: Target, via: "keyboard" | "click", rank: number, unshown = false) {
  noteSettingsSearchReveal(via, rank, unshown);
  jumpToSetting(target);
}

export function jumpToSetting({ id, pane, section }: Target) {
  const consent = consentToken();
  const key = settingsSectionKey(pane, section);
  useSettingsSearch.setState((s) => (s.revealedSections.includes(key) ? {} : { revealedSections: [...s.revealedSections, key] }));
  if (!useSettingsSearch.getState().previewing) goToSettingsPane(pane, settingsProfileFor(pane, useSettingsNav.getState()));
  else showWithoutHistory(pane);
  useSettingsSearch.setState({ ...requestReveal(id, consent), previewing: false });
}

export function previewSetting({ id, pane, section }: Target) {
  const consent = consentToken();
  const { query, previewing, reveal } = useSettingsSearch.getState();
  if (!query.trim()) return;
  if (reveal?.id === id && previewing && useSettingsNav.getState().pane === pane) return;
  if (!previewing) goToSettingsPane(pane, settingsProfileFor(pane, useSettingsNav.getState()));
  else showWithoutHistory(pane);
  useSettingsSearch.setState({ previewSection: settingsSectionKey(pane, section), previewing: true, ...requestReveal(id, consent) });
}

function showWithoutHistory(pane: SettingsPane) {
  const nav = useSettingsNav.getState();
  const profileId = settingsProfileFor(pane, nav);
  if (nav.pane !== pane || nav.profileId !== profileId || nav.detail) useSettingsNav.setState({ pane, profileId, detail: null, scroll: 0, visit: newSettingsVisit(), shownProfile: shownSettingsProfile({ pane, profileId, detail: null }), forward: [] });
}

export const setShortcutsQuery = (shortcutsQuery: string) => useSettingsSearch.setState({ shortcutsQuery });

export function revealCommandKeys(keys: string, via: "keyboard" | "click", rank: number) {
  noteSettingsSearch("keysOpened");
  setShortcutsQuery(keys);
  revealSetting(MENU_COMMANDS, via, rank);
}

export function previewCommandKeys(keys: string) {
  setShortcutsQuery(keys);
  previewSetting(MENU_COMMANDS);
}
