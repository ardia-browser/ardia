import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Modal, PlatformColor, StyleSheet, useWindowDimensions, View } from "react-native";
import { Button, Form, HStack, Label, RNHostView, Section, Spacer, Text, Toolbar, ToolbarItem, VStack, ZStack } from "@expo/ui/swift-ui";
import { settingsUI } from "@ardia/phone-native";
import { disabled, font, foregroundStyle, interactiveDismissDisabled, tint } from "@expo/ui/swift-ui/modifiers";
import { connectionWords, dismissWords, syncWords } from "../../lib/sharedWords";
import { copy } from "../../lib/platformCopy";
import type { ConnectResult } from "../../platform/sync";
import { haptics } from "../../state/app/haptics";
import { closeSettings, popSettings, pushSettings, useSettingsNav } from "../../state/settings/nav";
import { canPickSyncFolderFirst, checkPhrase, connectSync, syncConnectSession } from "../../state/sync/actions";
import { setConnectPhrase, useConnectDraft } from "../../state/sync/connectDraft";
import { IDLE_CONNECT, type ConnectState } from "../../state/sync/connectSession";
import { canScanCodes } from "../../state/sync/scan";
import { chooseFolderTitle, connectMessage, MAC_HINT } from "../../state/sync/syncRules";
import { legibleInk, modifierList, navigationBarBackButtonHidden, settingsChrome, settingsPage, useReduceMotion, useTheme } from "../ui";
import { SyncScan } from "../sync/SyncScan";
import { ExpoHero, ExpoSettingsAction, ExpoStep } from "./ExpoSettingsParts";

const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const noSubscription = () => () => undefined;
const STEP_CHROME = 102;
const PHRASE_BUTTONS_WIDTH = 380;

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

function PhraseButtons({ stacked, children }: { stacked: boolean; children: React.ReactNode }) {
  return stacked ? (
    <VStack alignment="leading" spacing={8}>
      {children}
    </VStack>
  ) : (
    <HStack spacing={8}>{children}</HStack>
  );
}
const idleConnect = (): ConnectState<ConnectResult> => IDLE_CONNECT;

export function ExpoSyncConnectPage() {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const isRoot = useSettingsNav((s) => connectIsStackRoot(s.stack));
  const window = useWindowDimensions();
  const buttonsFit = window.width - STEP_CHROME >= PHRASE_BUTTONS_WIDTH * window.fontScale;
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

  const page = (
    <Form modifiers={modifierList(settingsPage(syncWords.connect), tint(PlatformColor("systemBlue")), settingsChrome(), interactiveDismissDisabled(busy), isRoot ? null : navigationBarBackButtonHidden(busy))}>
      <ExpoHero title={syncWords.connect} subtitle="Two steps, and your Mac’s tabs are here." systemImage="macbook.and.iphone" tint="sync" />
      <Section title="Two Steps" footer={<Text>{copy().phraseStays}</Text>}>
        <ExpoStep number={1} title="Show the code on your Mac" detail={MAC_HINT} progress={hasPhrase ? "done" : "current"}>
          {hasPhrase ? (
            <HStack spacing={8}>
              <Label title="Recovery phrase added" systemImage="checkmark.circle.fill" modifiers={modifierList(font({ textStyle: "subheadline", weight: "medium" }), legibleInk("green"), settingsUI.accessibilityFocusRequest(scannerFocus.phraseAdded))} />
              <Spacer />
              <Button label="Change" onPress={() => pushSettings({ page: "syncWords" })} modifiers={[font({ textStyle: "subheadline" }), disabled(busy)]} />
            </HStack>
          ) : (
            <PhraseButtons stacked={!buttonsFit}>
              {scans ? <ExpoSettingsAction title={syncWords.scanCode} systemImage="qrcode.viewfinder" size="compact" isDisabled={busy} focusRequest={scannerFocus.scanCode} onPress={openScanner} /> : null}
              <ExpoSettingsAction title={syncWords.enterRecoveryPhrase} systemImage="character.cursor.ibeam" size="compact" emphasis={scans ? "secondary" : "primary"} isDisabled={busy} onPress={() => pushSettings({ page: "syncWords" })} />
            </PhraseButtons>
          )}
        </ExpoStep>
        <ExpoStep number={2} title="Choose the Ardia Sync folder" detail={copy().chooseFolderDetail} progress={hasPhrase ? "current" : "upcoming"}>
          <VStack alignment="leading" spacing={8}>
            {session && picked.folder && !picked.connecting ? <Label title={picked.folder.name} systemImage="folder.fill" modifiers={[font({ textStyle: "subheadline", weight: "medium" }), foregroundStyle(SECONDARY)]} /> : null}
            {session ? (
              <ExpoSettingsAction title={picked.folder ? "Choose Another Folder…" : "Choose Folder…"} size="compact" emphasis="secondary" busy={busy} busyValue={connectionWords.connecting} onPress={() => void session.pickFolder(phrase).then(finished)} />
            ) : (
              <ExpoSettingsAction title={chooseFolderTitle(lastResult)} size="compact" emphasis="secondary" isDisabled={!hasPhrase} busy={busy} busyValue={connectionWords.connecting} onPress={() => void connect()} />
            )}
            {problem ? <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(theme.destructive)]}>{problem}</Text> : null}
          </VStack>
        </ExpoStep>
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
