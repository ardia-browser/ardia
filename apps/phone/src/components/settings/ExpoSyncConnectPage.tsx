import { useEffect, useState, useSyncExternalStore } from "react";
import { Modal, PlatformColor, StyleSheet, useWindowDimensions, View } from "react-native";
import { Button, Form, HStack, Label, ProgressView, RNHostView, Section, Spacer, Text, VStack, ZStack } from "@expo/ui/swift-ui";
import { buttonBorderShape, buttonStyle, disabled, fixedSize, font, foregroundStyle, interactiveDismissDisabled, labelStyle, lineLimit, tint } from "@expo/ui/swift-ui/modifiers";
import { copy } from "../../lib/platformCopy";
import type { ConnectResult } from "../../platform/sync";
import { haptics } from "../../state/app/haptics";
import { popSettings, pushSettings } from "../../state/settings/nav";
import { canPickSyncFolderFirst, checkPhrase, connectSync, syncConnectSession } from "../../state/sync/actions";
import { setConnectPhrase, useConnectDraft } from "../../state/sync/connectDraft";
import { IDLE_CONNECT, type ConnectState } from "../../state/sync/connectSession";
import { canScanCodes } from "../../state/sync/scan";
import { chooseFolderTitle, connectMessage, MAC_HINT } from "../../state/sync/syncRules";
import { legibleInk, modifierList, settingsChrome, settingsPage, useTheme } from "../ui";
import { SyncScan } from "../sync/SyncScan";
import { ExpoHero, ExpoStep } from "./ExpoSettingsParts";
import { t } from "../../lib/uiLanguage";


const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const noSubscription = () => () => undefined;
const STEP_CHROME = 102;
const PHRASE_BUTTONS_WIDTH = 305;

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
  const window = useWindowDimensions();
  const buttonsFit = window.width - STEP_CHROME >= PHRASE_BUTTONS_WIDTH * window.fontScale;
  const phrase = useConnectDraft((s) => s.phrase);
  const [scans] = useState(canScanCodes);
  const [scanning, setScanning] = useState(false);
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
    if (session && hasPhrase) void session.connectIfReady(phrase).then(finished);
  }, [session, phrase, hasPhrase]);

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

  const capsule = [buttonBorderShape("roundedRectangle", 12), labelStyle("titleAndIcon"), lineLimit(1), fixedSize({ horizontal: true, vertical: false })];
  const prominent = [buttonStyle("borderedProminent"), tint(theme.primaryAction), foregroundStyle(theme.onPrimaryAction)];
  return (
    <ZStack>
    <Form modifiers={modifierList(settingsPage(t(`Connect to Your Mac`)), tint(PlatformColor("systemBlue")), settingsChrome(), interactiveDismissDisabled(busy))}>
      <ExpoHero title={t(`Connect to Your Mac`)} subtitle={t(`Two steps, and your Mac’s tabs are here.`)} systemImage="macbook.and.iphone" tint="sync" />
      <Section title={t(`Two Steps`)} footer={<Text>{copy().phraseStays}</Text>}>
        <ExpoStep number={1} title={t(`Show the code on your Mac`)} detail={MAC_HINT} progress={hasPhrase ? "done" : "current"}>
          {hasPhrase ? (
            <HStack spacing={8}>
              <Label title={t(`Recovery phrase added`)} systemImage="checkmark.circle.fill" modifiers={modifierList(font({ textStyle: "subheadline", weight: "medium" }), legibleInk("green"))} />
              <Spacer />
              <Button label={t(`Change`)} onPress={() => pushSettings({ page: "syncWords" })} modifiers={[font({ textStyle: "subheadline" })]} />
            </HStack>
          ) : (
            <PhraseButtons stacked={!buttonsFit}>
              {scans ? <Button label={t(`Scan Code`)} systemImage="qrcode.viewfinder" onPress={() => setScanning(true)} modifiers={[...prominent, ...capsule]} /> : null}
              <Button label={t(`Enter Words`)} systemImage="character.cursor.ibeam" onPress={() => pushSettings({ page: "syncWords" })} modifiers={[...(scans ? [buttonStyle("bordered")] : prominent), ...capsule]} />
            </PhraseButtons>
          )}
        </ExpoStep>
        <ExpoStep number={2} title={t(`Choose the Ardia Sync folder`)} detail={copy().chooseFolderDetail} progress={hasPhrase ? "current" : "upcoming"}>
          <VStack alignment="leading" spacing={8}>
            {session && picked.folder && !picked.connecting ? <Label title={picked.folder.name} systemImage="folder.fill" modifiers={[font({ textStyle: "subheadline", weight: "medium" }), foregroundStyle(SECONDARY)]} /> : null}
            {busy ? (
              <HStack spacing={8} modifiers={[font({ textStyle: "subheadline" })]}>
                <ProgressView />
                <Text modifiers={[foregroundStyle(SECONDARY)]}>Connecting…</Text>
              </HStack>
            ) : session ? (
              <Button label={picked.folder ? t(`Choose Another Folder…`) : t(`Choose Folder…`)} onPress={() => void session.pickFolder(phrase).then(finished)} modifiers={[buttonStyle("bordered"), ...capsule]} />
            ) : (
              <Button label={chooseFolderTitle(lastResult)} onPress={() => void connect()} modifiers={[buttonStyle("bordered"), ...capsule, disabled(!hasPhrase)]} />
            )}
            {problem ? <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(theme.destructive)]}>{problem}</Text> : null}
          </VStack>
        </ExpoStep>
      </Section>
    </Form>
      <RNHostView matchContents>
        <Modal visible={scanning} presentationStyle="fullScreen" animationType="slide" onRequestClose={() => setScanning(false)}>
          <View style={styles.cover}>
            <SyncScan
              inline
              onScan={(text) => {
                haptics.success();
                setConnectPhrase(text);
                setScanning(false);
              }}
              onEnterWords={() => {
                setScanning(false);
                pushSettings({ page: "syncWords" });
              }}
              onCancel={() => setScanning(false)}
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
