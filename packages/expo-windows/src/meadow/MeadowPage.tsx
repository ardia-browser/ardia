import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import type { MeadowIntroEvent, MeadowProps } from "@ardia/shaders";
import { takeKeyboardFor } from "../appKeyboard";
import { EngineWebView } from "../engine/EngineWebView";
import { engineAvailable } from "../engine/host";
import { callPage, discardOffered } from "../engine/pages";
import { privateWindowShown } from "../engine/privateWindows";
import { WindowIdContext } from "../engine/windowId";
import { requireNativeModule } from "../modules";
import type { FocusOnWindows } from "../textFocus";
import { meadowPageUrl } from "./pageUrl";
import { startMeadowSession, type MeadowSession } from "./session";

const PAGE_EVENTS = ["navigation", "loadError", "crashed", "openWindow"];
const KEYBOARD_BACK_MS = 150;

let opened = 0;

const focusModule = () => requireNativeModule<Pick<FocusOnWindows, "takeKeyboardFromPage">>("ArdiaFocus");

const within = (ms: number, work: Promise<unknown>) => Promise.race([work.catch(() => {}), new Promise((done) => setTimeout(done, ms))]);

function timers() {
  return {
    now: () => Date.now(),
    later(ms: number, run: () => void) {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    every(ms: number, run: () => void) {
      const timer = setInterval(run, ms);
      return () => clearInterval(timer);
    },
  };
}

export function MeadowPage({ intro, night, onIntro, onTone, style }: MeadowProps) {
  const windowId = useContext(WindowIdContext);
  const key = useRef(`meadow-intro-${++opened}`).current;
  const profile = `${key}@`;
  const [aspect, setAspect] = useState<number | null>(null);
  const [open, setOpen] = useState(true);
  const [shown, setShown] = useState(false);
  const session = useRef<MeadowSession | null>(null);
  const latest = useRef({ onIntro, onTone, night, muted: intro?.muted });
  latest.current = { onIntro, onTone, night, muted: intro?.muted };
  const usable = !!intro && engineAvailable();
  const url = useMemo(() => (usable && intro && aspect ? meadowPageUrl(intro, latest.current.night, aspect) : ""), [usable, aspect !== null]);

  useEffect(() => {
    if (intro && !usable) latest.current.onIntro?.({ kind: "poster" });
  }, []);

  useEffect(() => {
    if (!url || !intro) return;
    const release = privateWindowShown(profile);
    const tell = (event: MeadowIntroEvent) => latest.current.onIntro?.(event);
    const live = startMeadowSession(intro, latest.current.night, url, {
      ...timers(),
      evaluate: (code) => callPage<{ result?: unknown }>(key, "evaluate", { code }).then((reply) => reply?.result ?? null),
      run: (code) => void callPage(key, "executeJavaScript", { code }),
      show() {
        setShown(true);
        void callPage(key, "focus", {});
      },
      async close() {
        await within(KEYBOARD_BACK_MS, takeKeyboardFor(focusModule(), windowId));
        setOpen(false);
      },
      tell,
      tone: (tone) => latest.current.onTone?.(tone),
      log: (line) => console.info(line),
    });
    session.current = live;
    return () => {
      live.end();
      session.current = null;
      release();
    };
  }, [url]);

  useEffect(() => session.current?.setNight(night), [night]);

  useEffect(() => {
    if (typeof intro?.muted === "boolean") session.current?.setMuted(intro.muted);
  }, [intro?.muted]);

  if (!usable) return null;
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) setAspect((now) => now ?? width / height);
  };
  return (
    <View pointerEvents="none" style={style} onLayout={onLayout}>
      {url && open ? (
        <EngineWebView
          url={url}
          profile={profile}
          tabId={key}
          visible={shown}
          pageEvents={PAGE_EVENTS}
          style={StyleSheet.absoluteFill}
          onPageEvent={({ nativeEvent }) => {
            if (nativeEvent.name === "openWindow") {
              const adopt = (nativeEvent.data as { adoptId?: unknown } | null)?.adoptId;
              if (typeof adopt === "string") void discardOffered(adopt);
              return;
            }
            session.current?.pageEvent(nativeEvent.name, nativeEvent.data);
          }}
        />
      ) : null}
    </View>
  );
}
