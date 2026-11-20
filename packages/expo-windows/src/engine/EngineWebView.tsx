import { createElement, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useRef, type ComponentType } from "react";
import { View, type LayoutChangeEvent, type NativeMethods, type NativeSyntheticEvent } from "react-native";
import type { DomainModule, NativeProps, PageEvent, WebViewHandle } from "@ardia/ardiacore";
import type { AppWindowsModule } from "../nativeModuleTypes";
import { followMotion } from "../animation/motion";
import { fieldFocusedIn } from "../appKeyboard";
import { noteMissing } from "../missing";
import { requireNativeModule } from "../modules";
import { coversIn, hiddenByFullScreen, holesFor, onCoversChange, pageRadiusIn, setFullScreenPage } from "./covers";
import { MISSING_ANSWERS, pageMethod } from "./pageCalls";
import { downloadFavicon } from "./pageFavicon";
import { callPage, mountPage, showPage, type PageRect, type PageShape } from "./pages";
import { noteShowStep } from "./showTrace";
import { CoverAncestry } from "./usePageCover";
import { WindowIdContext } from "./windowId";

type PageEventsOnWindows = { onPageEvent?: (event: Pick<NativeSyntheticEvent<PageEvent>, "nativeEvent">) => void; onTop?: boolean };

type Props = Pick<NativeProps, "url" | "profile" | "adoptId" | "tabId" | "visible" | "style" | "contentsBackgroundColor"> & Partial<Pick<NativeProps, "temporary">> & Partial<Pick<NativeProps, "pageEvents">> & PageEventsOnWindows;


const SETTLE_MS = [0, 50, 200, 500];
const PICTURE_DEADLINE_MS = 1000;

type Picture = Awaited<ReturnType<WebViewHandle["capturePicture"]>>;

const appWindows = () => requireNativeModule<Pick<AppWindowsModule, "setPageFullScreen" | "capturePage">>("ArdiaAppWindows");

type Shown = { visible: boolean; placed: string; color: string; shows: number };

function capturePicture(windowId: string, shown: { current: Shown }, scale: number): Promise<Picture> {
  const { visible, placed, shows } = shown.current;
  if (!visible || !placed) return Promise.resolve(null);
  const { x, y, width, height } = JSON.parse(placed) as PageRect;
  const stillShown = () => shown.current.visible && shown.current.shows === shows;
  const capture = Promise.resolve(appWindows().capturePage(windowId, x, y, width, height, scale)).then(
    (data): Picture => (data && stillShown() ? { data, frame: [x, y, width, height] } : null),
    () => null,
  );
  const late = new Promise<Picture>((done) => setTimeout(() => done(null), PICTURE_DEADLINE_MS));
  return Promise.race([capture, late]);
}


const faviconsDomain = () => requireNativeModule<Pick<DomainModule, "call">>("ArdiaFavicons");

const setWindowFullScreen = (windowId: string, on: boolean) =>
  Promise.resolve(appWindows().setPageFullScreen(windowId, on)).then(
    () => {},
    () => {},
  );

let unnamed = 0;

export const EngineWebView = forwardRef<unknown, Props>(function EngineWebView(props, ref) {
  const windowId = useContext(WindowIdContext);
  const above = useRef(useContext(CoverAncestry));
  above.current = useContext(CoverAncestry);
  const key = useRef(props.tabId || `page-${++unnamed}`).current;
  const view = useRef<Pick<NativeMethods, "measureInWindow"> | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const visible = props.visible !== false;
  const shown = useRef<Shown>({ visible: false, placed: "", color: "", shows: 0 });
  const fullScreen = useRef(false);

  const place = useCallback(() => {
    const wanted = latest.current.visible !== false && !hiddenByFullScreen(windowId, key);
    if (!wanted) {
      noteShowStep(key, latest.current.visible === false ? "place: not visible" : "place: hidden by full screen");
      if (shown.current.visible) {
        shown.current = { visible: false, placed: "", color: "", shows: shown.current.shows + 1 };
        showPage(key, false, null, windowId);
      }
      return;
    }
    if (!view.current) noteShowStep(key, "place: no view");
    view.current?.measureInWindow((x, y, width, height) => {
      if (!view.current) return noteShowStep(key, "place: measured after the view was gone");
      if (latest.current.visible === false || hiddenByFullScreen(windowId, key) || !(width > 0) || !(height > 0)) return noteShowStep(key, `place: measured ${width}x${height}, visible ${latest.current.visible !== false}`);
      const page = { x, y, width, height };
      const shape: PageShape = fullScreen.current
        ? { ...page, radius: 0, holes: [] }
        : {
            ...page,
            radius: pageRadiusIn(windowId),
            holes: holesFor(page, coversIn(windowId, above.current), latest.current.temporary === true, latest.current.onTop === true),
          };
      const placed = JSON.stringify(shape);
      const color = latest.current.contentsBackgroundColor ?? "";
      if (shown.current.visible && shown.current.placed === placed && shown.current.color === color) return noteShowStep(key, "place: deduped");
      if (!showPage(key, true, shape, windowId, color || undefined)) return noteShowStep(key, `place: not taken ${width}x${height}`);
      noteShowStep(key, `place: show ${width}x${height}`);
      shown.current = { visible: true, placed, color, shows: shown.current.shows + 1 };
    });
  }, [key, windowId]);

  useEffect(() => onCoversChange((changed) => changed === windowId && place()), [windowId, place]);

  useEffect(() => followMotion(place), [place]);

  useEffect(() => {
    const first = latest.current;
    noteShowStep(key, `mount in ${windowId}`);
    const unmount = mountPage(key, { url: first.url, profile: first.profile, adopt: first.adoptId, contentsBackground: first.contentsBackgroundColor || undefined, windowId }, (name, data) => {
      if (name === "ready") {
        noteShowStep(key, "ready");
        place();
      }
      if (name === "fullscreen") {
        const on = !!(data as { fullscreen?: unknown } | null)?.fullscreen;
        if (on !== fullScreen.current) {
          fullScreen.current = on;
          setFullScreenPage(windowId, key, on && latest.current.visible !== false);
          void setWindowFullScreen(windowId, on).then(() => {
            if (on && fullScreen.current) void callPage(key, "focus");
          });
          place();
        }
      }
      const now = latest.current;
      if (now.pageEvents && !now.pageEvents.includes(name)) return;
      now.onPageEvent?.({ nativeEvent: { name, data } });
    });
    return () => {
      shown.current = { visible: false, placed: "", color: "", shows: shown.current.shows + 1 };
      if (fullScreen.current) {
        fullScreen.current = false;
        setFullScreenPage(windowId, key, false);
        void setWindowFullScreen(windowId, false);
      }
      unmount();
    };
  }, [key, windowId, place]);

  useEffect(() => {
    if (fullScreen.current) setFullScreenPage(windowId, key, visible);
  }, [windowId, key, visible]);

  useEffect(() => {
    const timers = SETTLE_MS.map((delay) => setTimeout(place, delay));
    return () => timers.forEach(clearTimeout);
  });

  useImperativeHandle(
    ref,
    () =>
      new Proxy(
        {},
        {
          get(_target, method) {
            if (typeof method !== "string" || method === "then" || method === "$$typeof") return undefined;
            if (method === "capturePicture") return (scale: number) => capturePicture(windowId, shown, scale);
            if (method === "downloadFavicon") return (url: string) => downloadFavicon(faviconsDomain(), latest.current.profile ?? "", url);
            if (method === "focusIfUnfocused") return async () => !fieldFocusedIn(windowId) && (await callPage(key, "focus", { follow: true })) !== null;
            const known = pageMethod(callPage, key, method);
            if (known) return known;
            return async () => {
              noteMissing(`<ArdiaWebView>.${method}`);
              return Object.hasOwn(MISSING_ANSWERS, method) ? MISSING_ANSWERS[method] : null;
            };
          },
        },
      ),
    [key, windowId],
  );

  const onLayout = useCallback((_event: LayoutChangeEvent) => place(), [place]);

  return createElement(View as ComponentType<Record<string, unknown>>, {
    ref: view,
    style: props.style,
    onLayout,
    collapsable: false,
    pointerEvents: visible ? "auto" : "none",
  });
});
