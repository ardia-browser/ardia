import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { View } from "react-native";
import { toAppUrl, toEngineUrl } from "@ardia/core";
import type { WebViewHandle, WebViewProps } from "@ardia-real/ardiacore";
import { ardiaHost, reportHostError } from "../../host";
import { HostPageEvents } from "../../hostPageEvents";
import { applyHostPageThemeState, forgetHostPageState, resetHostPageState } from "../../hostPageHooks";
import { hostPageScript } from "../../hostPageScripts";
import { pickOnLinuxPage, pickerStartPoint } from "../../elementPickerHost";
import { HostTab, type HostPageFactory, type HostTabEvent } from "../../hostTab";
import { extensionViewsSupported } from "../../hostExtensionView";
import { HostExtensionWebView } from "./HostExtensionWebView";
import { clipRadii } from "./clipRadii";
import { refreshTabViewports, watchTabViewport, type TabViewport } from "../../hostViewport";
import { inputRegions } from "../../shellAbove";
import type { InputRegionsRegistry } from "../../inputRegions";
import type { CornerRadii } from "../../hostExtensionView";
import { focusPageIfShellUnfocused, notePageFocusRequest, notingPageFocus } from "../../pageFocus";
import { withPopupDismissal } from "../../popupDismissal";
import { registerSwitchView } from "../../tabSwitchAhead";
import { noteLinuxPageViewportRejected } from "../../../../browser/src/state/telemetry/windowPlacementCounts.ts";

const pageCoveredListeners = new Set<(tabId: string) => void>();
export function onPageCovered(listener: (tabId: string) => void) {
  pageCoveredListeners.add(listener);
  return () => void pageCoveredListeners.delete(listener);
}

export const HostWebView = forwardRef<WebViewHandle, WebViewProps>(function HostWebView(props, ref) {
  return props.extensionHost && extensionViewsSupported(ardiaHost) ? <HostExtensionWebView ref={ref} {...props} /> : <HostTabWebView ref={ref} {...props} />;
});

const HostTabWebView = forwardRef<WebViewHandle, WebViewProps>(function HostTabWebView(props, ref) {
  const latest = useRef(props);
  latest.current = props;
  const element = useRef<HTMLDivElement>(null);
  const tab = useRef<HostTab | null>(null);
  const key = useRef(props.tabId ?? `host_${crypto.randomUUID()}`);
  const ready = useRef(false);

  const receive = (event: HostTabEvent) => {
    if (event.type !== "ready") return;
    refreshTabViewports();
    if (!ready.current) latest.current.onReady?.();
    ready.current = true;
  };
  const page: HostPageFactory = (claim, nativeId, rebound) => new HostPageEvents(claim, nativeId, () => notingPageFocus(withPopupDismissal(latest.current)),
    (reason, replaced) => { const tabId = latest.current.tabId; if (tabId) resetHostPageState(tabId, reason, replaced); },
    (state) => { const tabId = latest.current.tabId; if (tabId) applyHostPageThemeState(tabId, state); }, rebound);

  useEffect(() => {
    const host = ardiaHost!;
    const current = new HostTab(host, { key: key.current, temporary: !props.tabId, profile: props.profile, url: toEngineUrl(props.url ?? "about:blank"), ...(props.adoptId ? { adoptId: props.adoptId } : {}) }, receive, page);
    tab.current = current;
    void current.ready.catch((error) => {
      if (!current.disposed) latest.current.onLoadError?.({ url: latest.current.url ?? "", code: -2, text: String(error) });
      reportHostError(error);
    });
    return () => {
      current.dispose();
      if (tab.current === current) tab.current = null;
      const tabId = latest.current.tabId;
      if (tabId) forgetHostPageState(tabId);
    };
  }, []);

  useEffect(() => {
    void tab.current?.presentation(props.visible !== false).catch(reportHostError);
    refreshTabViewports();
  }, [props.visible]);

  useImperativeHandle(ref, () => new Proxy({} as WebViewHandle, {
    get(_target, property) {
      if (typeof property !== "string" || property === "then") return undefined;
      if (property === "nativeTag") return () => null;
      return async (...args: unknown[]) => {
        const current = tab.current;
        if (!current) throw new Error("Ardia tab is not mounted");
        if (property === "loadUrl") {
          args[0] = toEngineUrl(args[0] as string);
          if (current.repeatsCreate(args[0] as string)) return undefined;
        }
        if (property === "focusIfUnfocused") return focusPageIfShellUnfocused(() => current.command("focus", []));
        if (property === "focus") notePageFocusRequest();
        if (property === "getSecurityInfo") return current.pageResult(property, args);
        const script = hostPageScript(property, args);
        if (script) return script.map ? current.command(script.command, script.args).then(script.map, () => (script.failed ? script.failed() : script.map!(null))) : current.command(script.command, script.args);
        if (property === "evaluate") {
          const evaluate = async (code: unknown) => {
            const json = await current.pageResult<string | null>(property, [code]).catch(() => null);
            if (typeof json !== "string") return null;
            try { return JSON.parse(json); } catch { return null; }
          };
          const picking = pickerStartPoint(args[0]);
          return picking ? pickOnLinuxPage(evaluate, picking.point) : evaluate(args[0]);
        }
        const result = await current.command(property, args);
        if (property === "navigationEntries" && Array.isArray(result)) return result.map((entry: { url: string }) => ({ ...entry, url: toAppUrl(entry.url) }));
        return result;
      };
    },
  }), []);

  useEffect(() => {
    const node = element.current;
    const regions = inputRegions();
    if (!node || !regions) return;
    const covered = () => {
      const tabId = latest.current.tabId;
      if (tabId) for (const listener of pageCoveredListeners) listener(tabId);
    };
    const stop = watchPageBelowShell(node, regions, () => latest.current.visible !== false, () => tab.current, undefined, covered, () => clipRadii(node));
    const unregister = props.tabId ? registerSwitchView(props.tabId, { tab: () => tab.current, slot: node, regions }) : () => {};
    return () => {
      unregister();
      stop();
    };
  }, []);

  return <View style={[props.style, { backgroundColor: "transparent" }]}><div ref={element} data-ardia-native-tab={key.current} style={{ position: "absolute", inset: 0 }} /></View>;
});

export function watchPageBelowShell(node: HTMLElement, regions: InputRegionsRegistry, visible: () => boolean, page: () => { identity?: unknown; disposed?: boolean; viewport(viewport: TabViewport): Promise<void> } | null, radii?: () => CornerRadii, covered?: () => void, cardRadii?: () => CornerRadii) {
  let last = "";
  let shown = false;
  let revision = 0;
  const stop = watchTabViewport(node, visible, (viewport, coveredByShell) => {
    if (!viewport.visible) regions.setPage(node, false, radii, cardRadii);
    if (shown && coveredByShell) covered?.();
    shown = viewport.visible;
    regions.refresh();
    const current = page();
    if (!current?.identity) return;
    const sent = cardRadii && viewport.visible ? { ...viewport, radii: cardRadii() } : viewport;
    const json = JSON.stringify(sent);
    if (json === last) return;
    last = json;
    const mine = ++revision;
    void current.viewport(sent).then(() => {
      if (mine === revision && !current.disposed && viewport.visible) regions.setPage(node, true, radii, cardRadii);
    }, (error) => {
      if (mine === revision) last = "";
      if (viewport.visible) noteLinuxPageViewportRejected();
      reportHostError(error);
    });
  }, regions);
  return () => {
    revision++;
    stop();
    regions.dropPage(node);
  };
}
