import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { Button, Form, HStack, Label, RNHostView, Section, Text, Toolbar, ToolbarItem, VStack, ZStack } from "@expo/ui/swift-ui";
import { settingsUI } from "@ardia/phone-native";
import { accessibilityAddTraits, animation, Animation, disabled, font, foregroundStyle, frame, interactiveDismissDisabled, listRowBackground, listRowInsets, multilineTextAlignment, padding, preferredColorScheme, scrollContentBackground, tint } from "@expo/ui/swift-ui/modifiers";
import { connectionWords, dismissWords, syncWords } from "../../lib/sharedWords";
import type { ConnectResult } from "../../platform/sync";
import { haptics } from "../../state/app/haptics";
import { closeSettings, popSettings, pushSettings, useSettingsNav } from "../../state/settings/nav";
import { canPickSyncFolderFirst, checkPhrase, connectSync, syncConnectSession } from "../../state/sync/actions";
import { setConnectPhrase, useConnectDraft } from "../../state/sync/connectDraft";
import { IDLE_CONNECT, type ConnectState } from "../../state/sync/connectSession";
import { canScanCodes } from "../../state/sync/scan";
import { chooseFolderTitle, connectMessage, MAC_HINT } from "../../state/sync/syncRules";
import { legibleInk, modifierList, navigationBarBackButtonHidden, neverBounces, settingsPage, useReduceMotion, useTheme } from "../ui";
import { SyncScan } from "../sync/SyncScan";
import { ExpoSettingsAction } from "./ExpoSettingsParts";
import { brand } from "../onboarding/onboardingTokens";

const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const noSubscription = () => () => undefined;
const FILL = 10000;

const ONBOARDING_ACTION = { fill: brand.paper, ink: brand.ink, capsule: true } as const;

export const CONNECT_WORDS = {
  scanTitle: "Scan the code on your Mac",
  phraseTitle: "Enter the code from your Mac",
  folderTitle: "Choose the Ardia Sync folder",
  folderHint: "In iCloud Drive.",
  phraseAdded: "Code added",
  change: "Change",
} as const;

const CONNECT_LAYOUT = { top: 8, inset: 8, wordsGap: 6, statusGap: 12, statusTop: 6, actionsTop: 8, actionsGap: 14, swapS: 0.25 } as const;

export const scannerPresentation = (reduceMotion: boolean) => (reduceMotion ? "fade" : "slide");

export type ScannerExit = "cancel" | "scanned" | "enterWords";

export type ScannerFocus = { scanCode: number; phraseAdded: number; pushWords: boolean };

export const afterScanner = (exit: ScannerExit | null, focus: ScannerFocus): ScannerFocus => {
  const settled = { ...focus, pushWords: false };
  if (exit === "cancel") return { ...settled, scanCode: focus.scanCode + 1 };
  if (exit === "scanned") return { ...settled, phraseAdded: focus.phraseAdded + 1 };
  if (exit === "enterWords") return { ...settled, pushWords: true };
  return settled;
};

const NO_SCANNER_FOCUS: ScannerFocus = { scanCode: 0, phraseAdded: 0, pushWords: false };

export const connectIsStackRoot = (stack: readonly { page: string }[]) => stack[0]?.page === "syncConnect";

const idleConnect = (): ConnectState<ConnectResult> => IDLE_CONNECT;

export function ExpoSyncConnectPage() {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const isRoot = useSettingsNav((s) => connectIsStackRoot(s.stack));
  const phrase = useConnectDraft((s) => s.phrase);
  const [scans] = useState(canScanCodes);
  const [scanning, setScanning] = useState(false);
  const [coverShown, setCoverShown] = useState(false);
  const scannerExit = useRef<ScannerExit | null>(null);
  const [scannerFocus, setScannerFocus] = useState(NO_SCANNER_FOCUS);
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ConnectResult["result"] | null>(null);
  const [session] = useState(() => (canPickSyncFolderFirst() ? syncConnectSession() : null));
  const picked = useSyncExternalStore(session?.subscribe ?? noSubscription, session?.state ?? idleConnect);
  const hasPhrase = phrase.length > 0 && checkPhrase(phrase).isValid;
  const busy = connecting || picked.connecting;
  const problem = session ? (picked.failure ? connectMessage(picked.failure) : null) : failure;

  const finished = (result: ConnectResult | null) => {
    if (!result) return;
    if (result.result !== "connected") {
      haptics.error();
      return;
    }
    haptics.success();
    setConnectPhrase("");
    popSettings();
  };

  useEffect(() => () => session?.abandon(), [session]);
  useEffect(() => () => setConnectPhrase(""), []);
  useEffect(() => {
    if (session && hasPhrase && !coverShown) void session.connectIfReady(phrase).then(finished);
  }, [session, phrase, hasPhrase, coverShown]);

  const openScanner = () => {
    setCoverShown(true);
    setScanning(true);
  };

  const closeScanner = (exit: ScannerExit) => {
    scannerExit.current = exit;
    setScanning(false);
  };

  const scannerGone = () => {
    const next = afterScanner(scannerExit.current, scannerFocus);
    scannerExit.current = null;
    setScannerFocus(next);
    setCoverShown(false);
    if (next.pushWords) pushSettings({ page: "syncWords" });
  };

  const connect = async () => {
    if (!hasPhrase || connecting) return;
    setConnecting(true);
    setFailure(null);
    const result = await connectSync(phrase);
    setConnecting(false);
    setLastResult(result.result);
    if (result.result === "connected") finished(result);
    else {
      haptics.error();
      setFailure(connectMessage(result));
    }
  };

  const choosesFolder = hasPhrase;
  const title = choosesFolder ? CONNECT_WORDS.folderTitle : scans ? CONNECT_WORDS.scanTitle : CONNECT_WORDS.phraseTitle;
  const subtitle = problem ?? (choosesFolder ? CONNECT_WORDS.folderHint : MAC_HINT);
  const pickFolder = () => (session ? void session.pickFolder(phrase).then(finished) : void connect());
  const folderTitle = session ? (picked.folder ? "Choose Another Folder…" : "Choose Folder…") : chooseFolderTitle(lastResult);
  const accent = isRoot ? brand.cream : theme.spaceAccentInk;
  const look = isRoot ? ONBOARDING_ACTION : undefined;

  const page = (
    <Form modifiers={modifierList(settingsPage(syncWords.connect), tint(accent), isRoot ? preferredColorScheme("dark") : null, isRoot ? scrollContentBackground("hidden") : null, neverBounces(), interactiveDismissDisabled(busy), isRoot ? null : navigationBarBackButtonHidden(busy))}>
      <Section modifiers={[listRowBackground("clear"), listRowInsets({ top: CONNECT_LAYOUT.top, leading: CONNECT_LAYOUT.inset, bottom: 0, trailing: CONNECT_LAYOUT.inset })]}>
        <VStack spacing={CONNECT_LAYOUT.wordsGap} modifiers={[frame({ maxWidth: FILL }), animation(Animation.smooth({ duration: CONNECT_LAYOUT.swapS }), choosesFolder)]}>
          <Text modifiers={[font({ textStyle: "title2", weight: "bold" }), multilineTextAlignment("center"), accessibilityAddTraits(["isHeader"]), frame({ maxWidth: FILL })]}>{title}</Text>
          <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(problem ? theme.destructive : SECONDARY), multilineTextAlignment("center"), frame({ maxWidth: FILL })]}>{subtitle}</Text>
          {choosesFolder ? (
            <HStack spacing={CONNECT_LAYOUT.statusGap} modifiers={[padding({ top: CONNECT_LAYOUT.statusTop })]}>
              <Label title={CONNECT_WORDS.phraseAdded} systemImage="checkmark.circle.fill" modifiers={modifierList(font({ textStyle: "subheadline", weight: "medium" }), legibleInk("green"), settingsUI.accessibilityFocusRequest(scannerFocus.phraseAdded))} />
              <Button label={CONNECT_WORDS.change} onPress={() => pushSettings({ page: "syncWords" })} modifiers={[font({ textStyle: "subheadline" }), disabled(busy)]} />
            </HStack>
          ) : null}
        </VStack>
      </Section>
      <Section modifiers={[listRowBackground("clear"), listRowInsets({ top: CONNECT_LAYOUT.actionsTop, leading: CONNECT_LAYOUT.inset, bottom: 0, trailing: CONNECT_LAYOUT.inset })]}>
        <VStack spacing={CONNECT_LAYOUT.actionsGap}>
          {choosesFolder ? (
            <ExpoSettingsAction title={folderTitle} size="full" look={look} busy={busy} busyValue={connectionWords.connecting} onPress={pickFolder} />
          ) : scans ? (
            <ExpoSettingsAction title={syncWords.scanCode} size="full" look={look} isDisabled={busy} focusRequest={scannerFocus.scanCode} onPress={openScanner} />
          ) : (
            <ExpoSettingsAction title={syncWords.enterRecoveryPhrase} size="full" look={look} isDisabled={busy} onPress={() => pushSettings({ page: "syncWords" })} />
          )}
          {!choosesFolder && scans ? <Button label={syncWords.enterRecoveryPhrase} onPress={() => pushSettings({ page: "syncWords" })} modifiers={[font({ textStyle: "subheadline", weight: "medium" }), disabled(busy)]} /> : null}
        </VStack>
      </Section>
    </Form>
  );
  return (
    <ZStack>
      {isRoot ? (
        <Toolbar>
          {page}
          <Toolbar.Content>
            <ToolbarItem placement="cancellationAction">
              <Button label={dismissWords.cancel} role="cancel" onPress={closeSettings} modifiers={[disabled(busy)]} />
            </ToolbarItem>
          </Toolbar.Content>
        </Toolbar>
      ) : (
        page
      )}
      <RNHostView matchContents>
        <Modal visible={scanning} presentationStyle="fullScreen" animationType={scannerPresentation(reduceMotion)} onRequestClose={() => closeScanner("cancel")} onDismiss={scannerGone}>
          <View style={styles.cover}>
            <SyncScan
              inline
              onScan={(text) => {
                haptics.success();
                setConnectPhrase(text);
                closeScanner("scanned");
              }}
              onEnterWords={() => closeScanner("enterWords")}
              onCancel={() => closeScanner("cancel")}
            />
          </View>
        </Modal>
      </RNHostView>
    </ZStack>
  );
}

const styles = StyleSheet.create({
  cover: { flex: 1 },
});
