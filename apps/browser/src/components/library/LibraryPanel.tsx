import { memo, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import { useProfile, useSettings } from "../../state/browser/hooks";
import { chooseLibraryProfile, closeLibrary, setLibraryFilter, setLibraryQuery, setLibraryView } from "../../state/library/actions";
import { useLibraryFilter, useLibraryOpen, useLibraryQuery, useLibraryScope, useLibrarySection, useLibrarySections } from "../../state/library/hooks";
import { libraryOf, showLibrarySection, type LibrarySection, type MediaKind } from "../../state/library/library";
import { libraryViewOf, type LibraryListSection, type LibraryView } from "../../state/library/views";
import { useToolbarLightsCenter } from "../../state/windows/layout";
import { dismissLibraryCard } from "../../state/sidebar/hover";
import { useLibraryHeaderPointer } from "./useLibraryListPointer";
import { Button, iconButton, Symbol, Text, TextScopeContext, useTheme } from "../ui";
import { ProfileBadge } from "../profiles/ProfileIcons";
import { DownloadsSection } from "./DownloadsSection";
import { HistorySection } from "./HistorySection";
import { LibraryRail } from "./LibraryRail";
import { LibrarySearch, searchFieldButton } from "./LibrarySearch";
import { MediaFilter } from "./MediaFilter";
import { MediaSection } from "./MediaSection";
import { ProfileCards } from "./ProfileCards";
import { useLibraryLayout, useLibraryListPanel } from "./useLibraryLayout";
import { LibraryWindowContext } from "./useLibraryFocus";
import { LibraryContentFade, LibraryPageIn } from "./LibraryContentFade";
import { LIBRARY_MOTION } from "./motion";
import { ThumbnailsWantedContext } from "./useFileThumbnail";
import { LibraryScrollContext, LibraryScrollEdge, useLibraryScrollFrame } from "./LibraryScrollEdge";
import { LIBRARY, LIBRARY_EMPTY, LIBRARY_SEARCH, NO_RESULTS } from "./tokens";
import { markLibraryChange, noteLibraryPageSwitch, type LibraryChangeMark } from "../../state/telemetry/libraryCounts";

const P = LIBRARY.panel;
const ROOT = { flexDirection: "row", height: "100%" } as const;
const ROOT_MIRRORED = { flexDirection: "row-reverse", height: "100%" } as const;
const BODY = { flex: 1 } as const;
const HIDDEN = { display: "none" } as const;
const LIST_SECTIONS: readonly LibraryListSection[] = ["media", "downloads", "history"];
const NOTHING_BUILT: readonly LibrarySection[] = [];
const PREBUILD_AFTER_MS = 3_000;
const RELEASE_CLOSED_AFTER_MS = 120_000;
const PAGE = { ...StyleSheet.absoluteFillObject } as const;
const PAGE_HIDDEN = { ...StyleSheet.absoluteFillObject, display: "none" } as const;
const HEADER = { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: P.pad, gap: P.headerGap } as const;
const EMPTY = { flex: 1, alignItems: "center", justifyContent: "center", paddingBottom: LIBRARY.empty.lift } as const;

export function LibraryPanel({ windowId, right }: { windowId: string; right: boolean }) {
  const sections = useLibrarySections(windowId);
  const chosen = useLibrarySection(windowId);
  const section = sections.includes(chosen) ? chosen : sections[0]!;
  const query = useLibraryQuery(windowId);
  const filter = useLibraryFilter(windowId);
  const { rail, panel } = useLibraryLayout(windowId);
  const listPanel = useLibraryListPanel(windowId);
  const lightsY = useToolbarLightsCenter()[1];
  const entry = useRef<(() => void) | null>(null);
  const [entries] = useState(() => Object.fromEntries(LIST_SECTIONS.map((s) => [s, { current: null }])) as Record<LibraryListSection, RefObject<(() => void) | null>>);
  const switchedAt = useRef<LibraryChangeMark | null>(null);

  const select = useCallback(
    (s: LibrarySection) => {
      if (s !== libraryOf(windowId).section) switchedAt.current = markLibraryChange();
      showLibrarySection(windowId, s);
    },
    [windowId],
  );
  const back = useCallback(() => closeLibrary(windowId, "back"), [windowId]);
  const escapeRail = useCallback(() => closeLibrary(windowId, "escape"), [windowId]);
  const changeQuery = useCallback((text: string) => setLibraryQuery(windowId, text), [windowId]);
  const changeFilter = useCallback((kind: MediaKind) => setLibraryFilter(windowId, kind), [windowId]);
  const escape = useCallback(() => (query ? setLibraryQuery(windowId, "") : closeLibrary(windowId, "escape")), [windowId, query]);
  const shownSection = useRef(section);
  shownSection.current = section;
  const enterList = useCallback(() => (shownSection.current === "profiles" ? entry : entries[shownSection.current]).current?.(), [entries]);
  const views = useSettings((s) => s.sidebarLibraryViews);
  const view: LibraryView = section === "profiles" ? "list" : libraryViewOf(views, section);
  const scope = useLibraryScope(windowId);
  const open = useLibraryOpen(windowId);
  const openedOnce = useRef(false);
  if (open) openedOnce.current = true;
  useEffect(() => () => dismissLibraryCard(windowId), [windowId, section, view, scope.filter, open]);
  const scopedName = scope.filter ? scope.profiles[scope.filter]?.name : undefined;

  const searching = !!query.trim();
  const empties = useMemo(
    () => Object.fromEntries(LIST_SECTIONS.map((s) => [s, <EmptyTitle key={s} title={searching ? NO_RESULTS : scopedName ? `${LIBRARY_EMPTY[s]} in ${scopedName}` : LIBRARY_EMPTY[s]} />])) as Record<LibraryListSection, ReactNode>,
    [searching, scopedName],
  );
  const searchTop = Math.max(0, lightsY - LIBRARY.search.height / 2);
  const lastSection = useRef(section);
  const pageShift = lastSection.current === section ? 0 : Math.sign(sections.indexOf(section) - sections.indexOf(lastSection.current)) * LIBRARY_MOTION.page.shift;
  useEffect(() => void (lastSection.current = section), [section]);
  const [inset, setInset] = useState(0);
  const [scrolledBy, setScrolledBy] = useState<Partial<Record<LibraryListSection, boolean>>>({});
  const scrolled = section !== "profiles" && !!scrolledBy[section];
  const frames = useMemo(
    () =>
      Object.fromEntries(
        LIST_SECTIONS.map((s) => [s, { inset, onScrolled: (on: boolean) => setScrolledBy((by) => (!!by[s] === on ? by : { ...by, [s]: on })) }]),
      ) as Record<LibraryListSection, { inset: number; onScrolled: (on: boolean) => void }>,
    [inset],
  );
  const [visited, setVisited] = useState<readonly LibrarySection[]>(NOTHING_BUILT);
  const visit = useCallback((s: LibrarySection) => setVisited((now) => (now.includes(s) ? now : [...now, s])), []);
  const ready = section === "profiles" || visited.includes(section);
  useEffect(() => {
    if (ready) return;
    if (open) {
      const frame = requestAnimationFrame(() => visit(section));
      return () => cancelAnimationFrame(frame);
    }
    if (visited.length) return;
    const later = setTimeout(() => visit(section), PREBUILD_AFTER_MS);
    return () => clearTimeout(later);
  }, [ready, open, section, visited.length, visit]);
  useEffect(() => {
    if (open || visited.length <= 1) return;
    const later = setTimeout(() => {
      const kept = shownSection.current;
      for (const s of LIST_SECTIONS) if (s !== kept) entries[s].current = null;
      setVisited((now) => now.filter((s) => s === kept));
    }, RELEASE_CLOSED_AFTER_MS);
    return () => clearTimeout(later);
  }, [open, visited, entries]);
  useEffect(() => {
    if (!open) return;
    const next = sections.find((s) => s !== "profiles" && !visited.includes(s));
    if (!next) return;
    const later = setTimeout(() => visit(next), visited.length > 1 || switchedAt.current !== null ? LIBRARY_MOTION.page.prewarmGap : LIBRARY_MOTION.page.prewarm);
    return () => clearTimeout(later);
  }, [open, sections, visited, section, visit]);
  useEffect(() => {
    const started = switchedAt.current;
    if (started === null || !ready) return;
    switchedAt.current = null;
    const frame = requestAnimationFrame(() => noteLibraryPageSwitch(performance.now() - started.at, started.consent));
    return () => cancelAnimationFrame(frame);
  }, [section, ready]);
  const headerPointer = useLibraryHeaderPointer(windowId);
  const measureHeader = useCallback((e: LayoutChangeEvent) => setInset(Math.round(e.nativeEvent.layout.height)), []);

  return (
    <LibraryWindowContext.Provider value={windowId}>
      <ThumbnailsWantedContext.Provider value={openedOnce.current}>
      <TextScopeContext.Provider value="sidebar">
        <View style={[right ? ROOT_MIRRORED : ROOT, { width: rail + panel }]} accessibilityLabel="Library">
          <LibraryRail sections={sections} section={section} onSelect={select} onBack={back} onEscape={escapeRail} />
          <View style={{ width: panel }}>
            <View style={section === "profiles" ? HIDDEN : BODY}>
                  {LIST_SECTIONS.filter((s) => visited.includes(s) && sections.includes(s)).map((s) => {
                    const shown = s === section;
                    const sView = libraryViewOf(views, s);
                    const sEntry = entries[s];
                    const sEmpty = empties[s];
                    return (
                      <LibraryPageIn key={s} shown={shown} shift={open ? pageShift : 0} style={shown ? PAGE : PAGE_HIDDEN}>
                        <LibraryScrollContext.Provider value={frames[s]}>
                          <LibraryContentFade animate={open && shown} token={`${sView}:${s === "media" ? filter : ""}:${scope.filter ?? ""}`}>
                            {s === "media" ? (
                              <MediaSection view={sView} windowId={windowId} panelWidth={listPanel} entry={sEntry} empty={sEmpty} />
                            ) : s === "downloads" ? (
                              <DownloadsSection view={sView} windowId={windowId} panelWidth={listPanel} entry={sEntry} empty={sEmpty} />
                            ) : (
                              <HistorySection view={sView} windowId={windowId} panelWidth={listPanel} entry={sEntry} empty={sEmpty} />
                            )}
                          </LibraryContentFade>
                        </LibraryScrollContext.Provider>
                      </LibraryPageIn>
                    );
                  })}
            </View>
            {section !== "profiles" ? (
              <>
                <LibraryScrollEdge inset={inset} scrolled={scrolled} />
                <View {...headerPointer} onLayout={measureHeader} style={[HEADER, { paddingTop: searchTop, paddingBottom: section === "media" ? 0 : P.searchBelow }]}>
                <LibrarySearch
                  value={query}
                  placeholder={LIBRARY_SEARCH[section]}
                  onChange={changeQuery}
                  onEscape={escape}
                  onEnterList={enterList}
                  trailing={
                    <>
                      {scope.merged ? <ProfileFilter windowId={windowId} chosen={scope.filter} name={scopedName} /> : null}
                      <ViewToggle section={section} view={view} />
                    </>
                  }
                />
                {section === "media" ? <MediaFilter value={filter} onChange={changeFilter} /> : null}
                </View>
              </>
            ) : (
              <View style={{ height: searchTop }} />
            )}
            {sections.includes("profiles") ? (
              <LibraryPageIn shown={section === "profiles"} shift={open ? pageShift : 0} style={section === "profiles" ? BODY : HIDDEN}>
                <ProfileCards windowId={windowId} shown={open && section === "profiles"} entry={entry} empty={<EmptyTitle title={LIBRARY_EMPTY.profiles} />} />
              </LibraryPageIn>
            ) : null}
          </View>
        </View>
      </TextScopeContext.Provider>
      </ThumbnailsWantedContext.Provider>
    </LibraryWindowContext.Provider>
  );
}

const ViewToggle = memo(function ViewToggle({ section, view }: { section: LibraryListSection; view: LibraryView }) {
  const theme = useTheme();
  const next: LibraryView = view === "list" ? "cards" : "list";
  const plate = searchFieldButton();
  const lift = next === "list" ? LIBRARY.search.listGlyphLift : LIBRARY.search.gridGlyphLift;
  return (
    <Button variant="icon" size="m" {...plate} onPress={() => setLibraryView(section, next)} tooltip={next === "cards" ? "Show as Cards" : "Show as List"}>
      <Symbol
        name={next === "cards" ? "square.grid.2x2" : "list.bullet"}
        size={iconButton.m.glyph}
        color={theme.icon}
        style={{ width: plate.box, height: plate.box, transform: [{ translateY: -lift }] }}
      />
    </Button>
  );
});

const ProfileFilter = memo(function ProfileFilter({ windowId, chosen, name }: { windowId: string; chosen: string | null; name: string | undefined }) {
  const profile = useProfile(chosen, (p) => p);
  return (
    <Button
      variant="icon"
      icon="line.3.horizontal.decrease.circle"
      size="m"
      {...searchFieldButton()}
      onPress={() => void chooseLibraryProfile(windowId)}
      tooltip={name ? `Filter by Profile (${name})` : "Filter by Profile"}
    >
      {profile ? <ProfileBadge profile={profile} size={LIBRARY.profileBadge.filter} /> : undefined}
    </Button>
  );
});

const EmptyTitle = memo(function EmptyTitle({ title }: { title: string }) {
  const { inset } = useLibraryScrollFrame();
  return (
    <View style={[EMPTY, { paddingTop: inset }]}>
      <Text size="title" weight="medium" tone="textSecondary">
        {title}
      </Text>
    </View>
  );
});
