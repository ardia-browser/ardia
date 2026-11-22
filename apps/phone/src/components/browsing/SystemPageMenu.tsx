import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { BottomSheet, Button, ConfirmationDialog, Group, Host, RNHostView, Text, VStack } from "@expo/ui/swift-ui";
import { ignoreSafeArea, presentationDetents, presentationDragIndicator, type PresentationDetent } from "@expo/ui/swift-ui/modifiers";
import { closePageMenu, translatePage } from "../../state/page/actions";
import type { MenuModel } from "../../state/page/pageMenu";
import { PageMenuWords, usePageMenuInk } from "./PageMenuWords";

const HIDDEN_AFTER_MS = 450;
const UNMEASURED_DETENTS: PresentationDetent[] = ["medium", "large"];

let lastMenuHeight: number | null = null;

export const menuDetents = (height: number | null): PresentationDetent[] => (height ? [{ height }] : UNMEASURED_DETENTS);

type Props = {
  tabId: string;
  model: MenuModel;
  open: boolean;
  asksTranslation: boolean;
  onAsksTranslationChange: (asks: boolean) => void;
  onTranslate: () => void;
  onHidden: () => void;
};

export function SystemPageMenu({ tabId, model, open, asksTranslation, onAsksTranslationChange, onTranslate, onHidden }: Props) {
  const ink = usePageMenuInk();
  const [menuHeight, setMenuHeight] = useState(lastMenuHeight);
  const measured = (height: number) => {
    const fitted = Math.ceil(height);
    lastMenuHeight = fitted;
    setMenuHeight((now) => (now === fitted ? now : fitted));
  };
  useEffect(() => {
    if (open) return;
    const hide = setTimeout(onHidden, HIDDEN_AFTER_MS);
    return () => clearTimeout(hide);
  }, [open]);
  return (
    <Host testID="systemPageMenuSheet" style={styles.anchor} pointerEvents="none">
      <BottomSheet isPresented={open} onIsPresentedChange={(presented) => (presented ? undefined : closePageMenu())}>
        <Group modifiers={[presentationDetents(menuDetents(menuHeight)), presentationDragIndicator("visible")]}>
          <ConfirmationDialog title="Translate with Google?" isPresented={asksTranslation} onIsPresentedChange={onAsksTranslationChange} titleVisibility="visible">
            <ConfirmationDialog.Trigger>
              <VStack modifiers={[ignoreSafeArea({ edges: "bottom" })]}>
                <RNHostView>
                  <View testID="systemPageMenuFill" style={[styles.fill, { backgroundColor: ink.solid }]}>
                    <PageMenuWords tabId={tabId} model={model} onTranslate={onTranslate} onContentHeight={measured} />
                  </View>
                </RNHostView>
              </VStack>
            </ConfirmationDialog.Trigger>
            <ConfirmationDialog.Actions>
              <Button label="Translate" onPress={translatePage} />
            </ConfirmationDialog.Actions>
            <ConfirmationDialog.Message>
              <Text>Google will see this page’s address.</Text>
            </ConfirmationDialog.Message>
          </ConfirmationDialog>
        </Group>
      </BottomSheet>
    </Host>
  );
}

const styles = StyleSheet.create({
  anchor: { position: "absolute", width: 0, height: 0 },
  fill: { flex: 1 },
});
