import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Platform, StyleSheet, View, type ScrollViewInstance } from "react-native";
import { BottomSheet, Button, ConfirmationDialog, Group, Host, RNHostView, Text, VStack } from "@expo/ui/swift-ui";
import { ignoreSafeArea, presentationDetents, presentationDragIndicator, type PresentationDetent } from "@expo/ui/swift-ui/modifiers";
import { askTranslation, confirmTranslation, isCurrentShowing, pageMenuHostGone, pageMenuPresentation, releaseTranslationAsk, type MenuPresentation } from "../../state/page/actions";
import { usePageUi } from "../../state/page/store";
import { useMenuModel, useMenuOpen, useMenuOpening, useMenuPage, usePageQuiet, useTranslationAsk } from "../../state/page/hooks";
import { markMenuPhase } from "../../state/page/menuTiming";
import { settingsUIAvailable } from "../ui";
import type { Design } from "../../lib/design";
import { SettingsNavigation } from "../settings/ExpoSettingsStack";
import { PageMenuWords, usePageMenuInk } from "./PageMenuWords";

const contentLaidOut = () => markMenuPhase("laidOut");
const presentationIgnored = () => undefined;
const UNMEASURED_DETENTS: PresentationDetent[] = ["medium", "large"];
const FULL_SHEET = [presentationDetents(["large"], { selection: "large" }), presentationDragIndicator("automatic")];

let lastMenuHeight: number | null = null;

export const menuDetents = (height: number | null): PresentationDetent[] => (height ? [{ height }] : UNMEASURED_DETENTS);

export const usesSystemPageMenu = (design: Design) => design === "redesigned" && Platform.OS === "ios" && settingsUIAvailable();

export function SystemPageMenuHost({ tabId }: { tabId: string }) {
  const open = useMenuOpen();
  const [armed, setArmed] = useState(open);
  const quiet = usePageQuiet(tabId, armed);
  if (!armed && (open || quiet)) setArmed(true);
  const shownToken = useRef<number | null>(null);
  useEffect(() => () => pageMenuHostGone(shownToken.current), []);
  if (!armed && !open) return null;
  return <SystemPageMenu tabId={tabId} open={open} shownToken={shownToken} onPresentation={pageMenuPresentation} />;
}

type SystemPageMenuProps = { tabId: string; open: boolean; shownToken?: RefObject<number | null>; onPresentation: (presentation: MenuPresentation) => void };

export function SystemPageMenu({ tabId, open, shownToken, onPresentation }: SystemPageMenuProps) {
  const scroll = useRef<ScrollViewInstance | null>(null);
  const token = useMenuOpening();
  useLayoutEffect(() => {
    if (open) markMenuPhase("rendered");
  }, [open]);
  const presentation = (event: MenuPresentation) => {
    if (event.phase === "appear" && shownToken && event.token > 0) shownToken.current = event.token;
    if (event.phase === "dismiss" && isCurrentShowing(event.token) && !usePageUi.getState().menuOpen) scroll.current?.scrollTo({ y: 0, animated: false });
    onPresentation(event);
  };
  return (
    <Host testID="systemPageMenuSheet" style={styles.anchor} pointerEvents="none">
      <BottomSheet isPresented={open} keepsContentMounted presentationToken={token} onIsPresentedChange={presentationIgnored} onPresentation={presentation}>
        <SystemPageMenuContent tabId={tabId} scroll={scroll} />
      </BottomSheet>
    </Host>
  );
}

function SystemPageMenuContent({ tabId, scroll }: { tabId: string; scroll: RefObject<ScrollViewInstance | null> }) {
  const page = useMenuPage();
  const [menuHeight, setMenuHeight] = useState(lastMenuHeight);
  const measured = (height: number) => {
    if (height <= 0) return;
    const fitted = Math.ceil(height);
    lastMenuHeight = fitted;
    setMenuHeight((now) => (now === fitted ? now : fitted));
  };
  if (page === "siteSettings") {
    return (
      <Group testID="systemPageMenuSiteSettings" modifiers={FULL_SHEET}>
        <SettingsNavigation />
      </Group>
    );
  }
  return (
    <Group modifiers={[presentationDetents(menuDetents(menuHeight)), presentationDragIndicator("visible")]}>
      <PageMenuSheetWords tabId={tabId} scroll={scroll} onContentHeight={measured} />
    </Group>
  );
}

function PageMenuSheetWords({ tabId, scroll, onContentHeight }: { tabId: string; scroll: RefObject<ScrollViewInstance | null>; onContentHeight: (height: number) => void }) {
  const ink = usePageMenuInk();
  const model = useMenuModel(tabId);
  const ask = useTranslationAsk();
  return (
    <ConfirmationDialog title="Translate with Google?" isPresented={ask !== null} onIsPresentedChange={(presented) => (presented ? undefined : releaseTranslationAsk(ask))} titleVisibility="visible">
      <ConfirmationDialog.Trigger>
        <VStack modifiers={[ignoreSafeArea({ edges: "bottom" })]}>
          <RNHostView>
            <View testID="systemPageMenuFill" style={[styles.fill, { backgroundColor: ink.solid }]} onLayout={contentLaidOut}>
              <PageMenuWords tabId={tabId} model={model} onTranslate={askTranslation} systemSheet scrollRef={scroll} onContentHeight={onContentHeight} />
            </View>
          </RNHostView>
        </VStack>
      </ConfirmationDialog.Trigger>
      <ConfirmationDialog.Actions>
        <Button label="Translate" onPress={() => confirmTranslation(ask)} />
      </ConfirmationDialog.Actions>
      <ConfirmationDialog.Message>
        <Text>Google will see this page’s address.</Text>
      </ConfirmationDialog.Message>
    </ConfirmationDialog>
  );
}

const styles = StyleSheet.create({
  anchor: { position: "absolute", width: 0, height: 0 },
  fill: { flex: 1 },
});
