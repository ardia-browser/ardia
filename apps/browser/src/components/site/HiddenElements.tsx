import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { displayHost } from "@ardia/core";
import { Button, MenuRow, MenuSeparator, PANEL, PanelHeader, Popover, POPOVER_WIDTH, usePopoverPresence } from "../ui";
import { Favicon } from "../favicon/Favicon";
import { useTab } from "../../state/browser/hooks";
import { currentEngineProfile } from "../../state/browser/current";
import { setPopover } from "../../state/tabs/pageState";
import { dismissPopoverByPress } from "../../state/tabs/popoverDismiss";
import type { SitePanelPlace } from "./ZoomControls";
import { hiddenElementsOn, hiddenElementTitle, restoreHiddenElements, startHidingElement, useHiddenElements, type HiddenElement } from "../../state/site/hiddenElements";

export const HIDDEN_ELEMENTS_WIDTH = POPOVER_WIDTH.l;
const LIST_HEIGHT = 300;

export function HiddenElementsPopover({ open, ...place }: SitePanelPlace & { open: boolean }) {
  const presence = usePopoverPresence(open);
  return presence.shown ? <HiddenElementsPanel {...place} closing={presence.closing} onClosed={presence.onClosed} /> : null;
}

function HiddenElementsPanel({ tabId, right, left, top, closing, onClosed }: SitePanelPlace & { closing: boolean; onClosed: () => void }) {
  const tab = useTab(tabId);
  const changes = useHiddenElements((s) => s.changes);
  const [listed, setListed] = useState<{ host: string; elements: HiddenElement[] } | null>(null);
  const url = tab?.url ?? "";
  useEffect(() => {
    let live = true;
    void hiddenElementsOn(tabId).then((found) => live && setListed(found));
    return () => {
      live = false;
    };
  }, [tabId, url, changes]);
  if (!tab) return null;
  const close = () => setPopover(tabId, null);
  const profile = currentEngineProfile(tab.profileId);
  const elements = listed?.elements ?? [];
  const restore = (which: HiddenElement[]) => void restoreHiddenElements(profile, which);
  const hideAnother = () => {
    close();
    void startHidingElement(tabId);
  };
  const host = listed?.host ?? "";
  const count = elements.length;
  return (
    <Popover width={HIDDEN_ELEMENTS_WIDTH} top={top} right={right} left={left} onDismiss={() => dismissPopoverByPress(tabId)} fitHeight glass closing={closing} onClosed={onClosed}>
      <View style={{ paddingTop: PANEL.inset, paddingBottom: PANEL.rowInset }}>
        <PanelHeader
          icon={<Favicon url={url} favicon={tab.favicon} size={PANEL.iconSlot} profileId={tab.profileId} />}
          title={host ? `Hidden on ${displayHost(host)}` : "Hidden Elements"}
          subtitle={!listed ? "…" : count ? `${count} element${count === 1 ? "" : "s"} hidden on every visit` : "Nothing hidden on this site"}
        />
        {count ? (
          <ScrollView style={{ maxHeight: LIST_HEIGHT }}>
            {elements.map((e) => (
              <MenuRow
                key={e.filter}
                icon="eye.slash"
                title={hiddenElementTitle(e.selector)}
                tooltip={e.session ? `${e.selector} (this private session only)` : e.selector}
                accessory={<Button variant="pill" title="Show" onPress={() => restore([e])} />}
              />
            ))}
          </ScrollView>
        ) : null}
        <MenuSeparator />
        <MenuRow icon="eye.slash" title={count ? "Hide Another Element…" : "Hide an Element…"} onPress={hideAnother} />
        {count > 1 ? <MenuRow icon="eye" title="Show All Again" onPress={() => restore(elements)} /> : null}
      </View>
    </Popover>
  );
}
