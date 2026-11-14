import { createElement, forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ComponentType } from "react";
import { View } from "react-native";
import { callPage, discardPage, focusPage, mountPage, pageElement, setPageVisible } from "./pages";

type PageEvent = { name: string; data: unknown };

type Props = {
  url?: string;
  profile?: string;
  tabId?: string;
  visible?: boolean;
  style?: unknown;
  pageEvents?: string[];
  contentsBackgroundColor?: string;
  onPageEvent?: (event: { nativeEvent: PageEvent }) => void;
};

const ARGUMENTS: Record<string, string[]> = {
  loadUrl: ["url", "userInitiated"],
  goBack: [],
  goForward: [],
  goToOffset: ["offset"],
  reload: [],
  forceReload: [],
  stopLoading: [],
  setMuted: ["muted"],
  find: ["text", "forward", "findNext"],
  stopFinding: ["clear"],
  zoomStep: ["direction"],
  executeJavaScript: ["code"],
  evaluate: ["code"],
  navigationEntries: [],
  showDevTools: ["panel"],
  print: [],
  runPageCommand: ["name"],
  getSecurityInfo: [],
  mediaCommand: ["action", "seconds"],
  clearSiteData: [],
  pageCookies: ["urls"],
  downloadImage: ["url", "maxPixels"],
  downloadFavicon: ["url"],
  resolveDisplayMedia: ["id", "sourceId", "audio"],
  resolveUnresponsive: ["terminate"],
  resolvePasswordPrompt: ["answer", "username", "password"],
  resolveAutofillPrompt: ["id", "answer"],
  executeExtensionAction: ["extensionId"],
  openBlockedPopup: ["id", "always"],
  requestPictureInPicture: ["press"],
};

const UNWRAPPED: Record<string, (reply: Record<string, unknown> | null) => unknown> = {
  evaluate: (reply) => reply?.result ?? null,
  navigationEntries: (reply) => reply?.entries ?? [],
  pageCookies: (reply) => reply?.cookies ?? [],
  clearSiteData: (reply) => reply ?? { cookies: false, storage: false },
  getSecurityInfo: (reply) => reply ?? null,
  downloadImage: (reply) => reply ?? null,
  downloadFavicon: (reply) => reply ?? null,
  executeExtensionAction: (reply) => reply ?? null,
  requestPictureInPicture: (reply) => (reply as unknown) === true,
};

const LOCAL_ANSWERS: Record<string, unknown> = {
  takeControlPress: false,
  mediaCaptureSourceId: null,
};

const EXIT_PICTURE_IN_PICTURE = "if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});";

const missingLogged = new Set<string>();
function noteMissing(method: string) {
  if (missingLogged.has(method)) return;
  missingLogged.add(method);
  console.warn(`[ardia linux] <ArdiaWebView>.${method} is not on Linux yet`);
}

let unnamed = 0;

export const ArdiaWebView = forwardRef<unknown, Props>(function ArdiaWebView(props, ref) {
  const holder = useRef<HTMLElement | null>(null);
  const key = useRef(props.tabId || `page-${++unnamed}`).current;
  const latest = useRef(props);
  latest.current = props;
  const visible = props.visible !== false;

  useLayoutEffect(() => {
    const element = holder.current;
    if (!element) return;
    const first = latest.current;
    const unmount = mountPage(
      key,
      { url: first.url, profile: first.profile, tabId: first.tabId, windowId: element.ownerDocument.defaultView?.name ?? "", background: first.contentsBackgroundColor },
      (name, data) => {
        const now = latest.current;
        if (now.pageEvents && !now.pageEvents.includes(name)) return;
        now.onPageEvent?.({ nativeEvent: { name, data } });
      },
      element,
    );
    setPageVisible(key, latest.current.visible !== false);
    return unmount;
  }, [key]);

  useLayoutEffect(() => setPageVisible(key, visible), [key, visible]);

  useImperativeHandle(
    ref,
    () =>
      new Proxy(
        {},
        {
          get(_target, method) {
            if (typeof method !== "string" || method === "then" || method === "$$typeof") return undefined;
            if (method === "focus") return () => focusPage(key);
            if (method === "discard") return () => discardPage(key);
            if (method === "capturePicture")
              return async (scale: number) => {
                const shown = () => latest.current.visible !== false;
                if (!shown()) return null;
                const reply = await callPage<{ data: string }>(key, "capture", { scale });
                const element = pageElement(key);
                if (!reply?.data || !element || !shown()) return null;
                const rect = element.getBoundingClientRect();
                return { data: reply.data, frame: [rect.x, rect.y, rect.width, rect.height] };
              };
            if (method === "exitPictureInPicture") return () => callPage(key, "executeJavaScript", { code: EXIT_PICTURE_IN_PICTURE }).then(() => undefined);
            if (method === "setFrozen" || method === "notificationAction")
              return async () => undefined;
            const names = ARGUMENTS[method];
            if (names) {
              const unwrap = UNWRAPPED[method];
              return async (...values: unknown[]) => {
                const reply = await callPage<Record<string, unknown>>(key, method, Object.fromEntries(names.map((name, index) => [name, values[index] ?? null])));
                return unwrap ? unwrap(reply) : undefined;
              };
            }
            return async () => {
              if (!Object.hasOwn(LOCAL_ANSWERS, method)) noteMissing(method);
              return Object.hasOwn(LOCAL_ANSWERS, method) ? LOCAL_ANSWERS[method] : null;
            };
          },
        },
      ),
    [key],
  );

  return createElement(View as ComponentType<Record<string, unknown>>, {
    ref: holder,
    style: props.style,
    collapsable: false,
    pointerEvents: visible ? "auto" : "none",
  });
});
