import { useEffect, useRef } from "react";
import { View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { useWindowId } from "../../state/browser/hooks";
import { attachSiteContext, dropWindowContexts, noteContextNavigation, useSiteContexts, type SiteContextView } from "../../state/plugins/siteContexts";
import { WebView, type WebViewHandle } from "../ui";

export function PluginSiteContexts() {
  const windowId = useWindowId();
  const contexts = useSiteContexts(useShallow((s) => Object.values(s.contexts).filter((c) => c.windowId === windowId)));
  useEffect(() => () => dropWindowContexts(windowId), [windowId]);
  if (!contexts.length) return null;
  return (
    <View pointerEvents="none" style={HOLDER} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {contexts.map((c) => (
        <SiteContext key={c.key} context={c} />
      ))}
    </View>
  );
}

function SiteContext({ context }: { context: SiteContextView }) {
  const web = useRef<WebViewHandle>(null);
  useEffect(() => {
    attachSiteContext(context.key, web.current);
    return () => attachSiteContext(context.key, null);
  }, [context.key]);
  return <WebView ref={web} style={PAGE} url={context.anchor} profile={context.profile} standalone visible={false} onNavigationChange={(state) => noteContextNavigation(context.key, state.url)} />;
}

const HOLDER = { position: "absolute", left: 0, top: 0, width: 1, height: 1, opacity: 0, overflow: "hidden" } as const;
const PAGE = { width: 1, height: 1 } as const;
