import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, findNodeHandle } from "react-native";
import { reduceMotion } from "../ui";
import { isQuitting } from "../../state/app/quit";
import { useLibraryAvailable, useLibraryOpen } from "../../state/library/hooks";
import { pagerFor, pagerMorphsNatively, usePagerNativeConfig } from "../../state/windows/profilePager";
import { LIBRARY_MOTION } from "./motion";
import { useLibraryLayout } from "./useLibraryLayout";

const M = LIBRARY_MOTION.morph;
const MORPH_RETRY_MS = 250;

export function useLibraryLead(windowId: string) {
  const open = useLibraryOpen(windowId);
  const pager = pagerFor(windowId);
  const target = useRef(open);
  useEffect(() => {
    if (target.current === open) return;
    target.current = open;
    if (pager.drivesLibraryNatively) return;
    Animated.spring(pager.lead, { toValue: open ? 1 : 0, ...LIBRARY_MOTION.spring, useNativeDriver: true }).start();
  }, [pager, open]);
  return { open, lead: pager.lead };
}

function useMorphSpan(windowId: string, live: boolean, open: boolean) {
  const { lead } = pagerFor(windowId);
  const span = useRef(new Animated.Value(0)).current;
  const still = reduceMotion();
  useEffect(() => {
    if (!live) return span.setValue(0);
    if (still) return span.setValue(open ? 1 : 0);
    let last = (lead as unknown as { __getValue(): number }).__getValue();
    span.setValue(last);
    const id = lead.addListener(({ value }) => {
      if (value === last) return;
      last = value;
      span.setValue(value);
    });
    const pager = pagerFor(windowId);
    const settled = pager.state.subscribe(() => {
      const rest = pager.settledLead();
      if (rest === null || rest === last) return;
      last = rest;
      span.setValue(rest);
    });
    return () => {
      lead.removeListener(id);
      settled();
    };
  }, [span, lead, live, still, still && open, windowId]);
  return span;
}

function useMorphRoom(width: number, live: boolean) {
  const room = useRef(new Animated.Value(width)).current;
  const last = useRef(width);
  useEffect(() => {
    if (last.current === width) return;
    last.current = width;
    room.stopAnimation();
    if (!live || reduceMotion() || isQuitting()) return room.setValue(width);
    Animated.spring(room, { toValue: width, ...LIBRARY_MOTION.spring, useNativeDriver: false }).start();
  }, [room, width, live]);
  return room;
}

function useNativeMorph(windowId: string, live: boolean, sidebar: number, library: number, clip: number, content: number, spacer: number, right: boolean) {
  const pager = pagerFor(windowId);
  const still = reduceMotion() === true;
  useEffect(() => {
    if (!live) return;
    if (!spacer) return;
    const config = { clip, content, spacer, sidebar, library, still, right };
    let placed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const place = () =>
      void pager.morph(config).then((ok) => {
        placed = ok;
        if (!ok && !stopped) retry = setTimeout(place, MORPH_RETRY_MS);
      });
    let stopped = false;
    const unsubscribe = pager.state.subscribe(() => {
      if (!placed) place();
    });
    place();
    return () => {
      stopped = true;
      clearTimeout(retry);
      unsubscribe();
    };
  }, [pager, windowId, live, sidebar, library, clip, content, spacer, still, right]);
  useEffect(() => {
    if (!live) return;
    return () => void pagerFor(windowId).morph(null);
  }, [windowId, live]);
}

const tagSetter = (set: (tag: number) => void) => (view: unknown) => set((view ? findNodeHandle(view as Parameters<typeof findNodeHandle>[0]) : null) || 0);

export function useLibraryMorph(windowId: string, sidebarWidth: number, right: boolean) {
  const available = useLibraryAvailable(windowId);
  const open = useLibraryOpen(windowId);
  const { rail, panel } = useLibraryLayout(windowId);
  const native = pagerMorphsNatively && !!usePagerNativeConfig(windowId);
  const [clip, setClip] = useState(0);
  const [spacer, setSpacer] = useState(0);
  const [content, setContent] = useState(0);
  const span = useMorphSpan(windowId, available && !native, open);
  const room = useMorphRoom(rail + panel, !native);
  useNativeMorph(windowId, available && native, sidebarWidth, rail + panel, clip, content, spacer, right);
  const growth = useMemo(() => Animated.multiply(span.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: "clamp" }), Animated.add(room, -sidebarWidth)), [span, room, sidebarWidth]);
  const width = useMemo(() => Animated.add(growth, sidebarWidth), [growth, sidebarWidth]);
  const onClip = useMemo(() => tagSetter(setClip), []);
  const onSpacer = useMemo(() => tagSetter(setSpacer), []);
  const onContent = useMemo(() => tagSetter(setContent), []);
  return { growth, width, open: open && available, available, native, onClip, onSpacer, onContent };
}

export function useLibraryMorphStyles(windowId: string, outward: 1 | -1) {
  const { lead } = pagerFor(windowId);
  const still = reduceMotion();
  return useMemo(() => {
    const drift = still ? 0 : M.drift * outward;
    const sidebar = {
      opacity: lead.interpolate({ inputRange: [0, M.sidebarGoneBy], outputRange: [1, 0], extrapolate: "clamp" }),
      transform: [{ translateX: lead.interpolate({ inputRange: [0, M.sidebarGoneBy], outputRange: [0, drift], extrapolate: "clamp" }) }],
    };
    const library = {
      opacity: lead.interpolate({ inputRange: [M.libraryFrom, M.librarySolidBy], outputRange: [0, 1], extrapolate: "clamp" }),
      transform: [{ translateX: lead.interpolate({ inputRange: [M.libraryFrom, M.librarySolidBy], outputRange: [-drift, 0], extrapolate: "clamp" }) }],
    };
    return { sidebar, library };
  }, [lead, outward, still]);
}
