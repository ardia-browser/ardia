import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, BackHandler, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { canPickSyncFolderFirst, checkPhrase, connectSync, syncConnectSession } from "../../state/sync/actions";
import { IDLE_CONNECT, type ConnectState } from "../../state/sync/connectSession";
import { haptics } from "../../state/app/haptics";
import { chooseFolderTitle, setupStepLabel, connectMessage, MAC_HINT, phraseFooter } from "../../state/sync/syncRules";
import { capsule, font, radius, settingsLayout, space, spacesLayout, Symbol, tabsMotion, useDesign, useTheme, useReduceMotion } from "../ui";
import { BarButton, CrossfadeText, Group, SettingsPage } from "../settings/SettingsKit";
import Animated, { FadeIn, FadeOut, SlideInRight, SlideOutRight } from "react-native-reanimated";
import { CapsuleButton, PasteAction, SyncHero } from "./SyncPage";
import { SyncScan } from "./SyncScan";
import { copy } from "../../lib/platformCopy";
import type { ConnectResult } from "../../platform/sync";
import { canScanCodes } from "../../state/sync/scan";
import { t } from "../../lib/uiLanguage";


type FlowProps = { onClose: () => void; onConnected: () => void; closes?: boolean };

export function SyncConnect({ onClose, onConnected, closes }: FlowProps) {
  const material = useDesign() === "material";
  const [phrase, setPhrase] = useState("");
  const [entering, setEntering] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scans] = useState(canScanCodes);
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ConnectResult["result"] | null>(null);
  const hasPhrase = phrase.length > 0 && checkPhrase(phrase).isValid;
  const [session] = useState(() => (canPickSyncFolderFirst() ? syncConnectSession() : null));
  const picked = useSyncExternalStore(session?.subscribe ?? noSubscription, session?.state ?? idleConnect);
  const busy = connecting || picked.connecting;
  const reduceMotion = useReduceMotion();

  const finished = (result: ConnectResult | null) => {
    if (!result) return;
    if (result.result !== "connected") {
      haptics.error();
      return;
    }
    haptics.success();
    setPhrase("");
    onConnected();
  };

  useEffect(() => () => session?.abandon(), [session]);

  useEffect(() => {
    if (session && hasPhrase) void session.connectIfReady(phrase).then(finished);
  }, [session, phrase, hasPhrase]);

  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (busy) return true;
      if (scanning) setScanning(false);
      else if (entering) setEntering(false);
      else onClose();
      return true;
    });
    return () => back.remove();
  }, [busy, entering, scanning, onClose]);

  const connect = async () => {
    if (!hasPhrase || connecting) return;
    setConnecting(true);
    setFailure(null);
    const result = await connectSync(phrase);
    setConnecting(false);
    setLastResult(result.result);
    if (result.result === "connected") {
      haptics.success();
      setPhrase("");
      onConnected();
    } else {
      haptics.error();
      setFailure(connectMessage(result));
    }
  };

  if (scanning) {
    return (
      <SyncScan
        onScan={(text) => {
          if (!picked.folder) haptics.success();
          setPhrase(text);
          setFailure(null);
          setScanning(false);
        }}
        onEnterWords={() => {
          setScanning(false);
          setEntering(true);
        }}
        onCancel={() => setScanning(false)}
      />
    );
  }
  const words = entering ? (
    <Animated.View
      testID="enterWordsPushed"
      entering={reduceMotion ? FadeIn.duration(tabsMotion.fade) : SlideInRight.duration(PUSH_MS)}
      exiting={reduceMotion ? FadeOut.duration(tabsMotion.fade) : SlideOutRight.duration(PUSH_MS)}
      style={StyleSheet.absoluteFill}
    >
      <PhraseEntry
        initial={phrase}
        onBack={() => setEntering(false)}
        onUse={(text) => {
          setPhrase(text);
          setFailure(null);
          setEntering(false);
        }}
      />
    </Animated.View>
  ) : null;
  return (
    <View style={StyleSheet.absoluteFill}>
      <View style={StyleSheet.absoluteFill} importantForAccessibility={entering ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={entering}>
        <SettingsPage title={t(`Connect to Your Mac`)} onBack={closes || busy ? undefined : onClose} onClose={material && closes && !busy ? onClose : undefined} leading={closes && !material ? <BarButton title={t(`Close`)} onPress={onClose} enabled={!busy} /> : undefined}>
          <SyncHero title={t(`Connect to Your Mac`)} subtitle={t(`Two steps, and your Mac’s tabs are here.`)} />
          <Group header={t(`Two Steps`)} footer={copy().phraseStays}>
            <Step number={1} title={t(`Show the code on your Mac`)} detail={MAC_HINT} done={hasPhrase} current>
              {hasPhrase ? (
                <Animated.View key="added" entering={STEP_IN} exiting={STEP_OUT}>
                  <PhraseAdded onChange={() => setEntering(true)} />
                </Animated.View>
              ) : (
                <Animated.View key="ways" entering={STEP_IN} exiting={STEP_OUT} style={styles.ways}>
                  {scans ? <CapsuleButton title={t(`Scan Code`)} icon="qrcodeViewfinder" prominent onPress={() => setScanning(true)} /> : null}
                  <CapsuleButton title={t(`Enter Words`)} icon="textCursor" prominent={!scans} onPress={() => setEntering(true)} />
                </Animated.View>
              )}
            </Step>
            <Step number={2} title={t(`Choose the Ardia Sync folder`)} detail={copy().chooseFolderDetail} done={false} current={hasPhrase}>
              {session ? (
                <>
                  {picked.folder && !picked.connecting ? (
                    <Animated.View entering={STEP_IN} exiting={STEP_OUT}>
                      <PickedFolder name={picked.folder.name} />
                    </Animated.View>
                  ) : null}
                  {picked.connecting ? (
                    <Animated.View entering={STEP_IN} exiting={STEP_OUT}>
                      <Connecting />
                    </Animated.View>
                  ) : (
                    <CapsuleButton title={picked.folder ? t(`Choose Another Folder…`) : t(`Choose Folder…`)} onPress={() => void session.pickFolder(phrase).then(finished)} />
                  )}
                  {picked.failure && connectMessage(picked.failure) ? <Problem text={connectMessage(picked.failure)!} /> : null}
                </>
              ) : (
                <>
                  {connecting ? (
                    <Animated.View entering={STEP_IN} exiting={STEP_OUT}>
                      <Connecting />
                    </Animated.View>
                  ) : (
                    <CapsuleButton title={chooseFolderTitle(lastResult)} enabled={hasPhrase} onPress={() => void connect()} />
                  )}
                  {failure ? <Problem text={failure} /> : null}
                </>
              )}
            </Step>
          </Group>
        </SettingsPage>
      </View>
      {words}
    </View>
  );
}

function Step({ number, title, detail, done, current, children }: { number: number; title: string; detail: string; done: boolean; current: boolean; children: React.ReactNode }) {
  const theme = useTheme();
  const ink = done ? theme.switchOn : current ? theme.formAccent : theme.tertiaryLabel;
  return (
    <View style={styles.step}>
      <View accessible accessibilityLabel={setupStepLabel(number, done, current)} style={[styles.badge, { borderColor: ink, backgroundColor: done ? ink : undefined }]}>
        {done ? <Symbol name="checkmark" size={14} color={theme.groupFill} /> : <Text style={[font.footnote, styles.bold, { color: ink }]}>{number}</Text>}
      </View>
      <View style={styles.stepBody}>
        <Text style={[font.body, styles.bold, { color: current || done ? theme.label : theme.secondaryLabel }]}>{title}</Text>
        <Text style={[font.footnote, { color: theme.secondaryLabel }]}>{detail}</Text>
        <View style={styles.stepActions}>{children}</View>
      </View>
    </View>
  );
}

function PhraseAdded({ onChange }: { onChange: () => void }) {
  const theme = useTheme();
  return (
    <View style={styles.added}>
      <Symbol name="checkmarkCircle" size={18} color={theme.switchOn} />
      <Text style={[font.subheadline, styles.medium, styles.fill, { color: theme.switchOn }]}>Recovery phrase added</Text>
      <BarButton title={t(`Change`)} onPress={onChange} />
    </View>
  );
}

const noSubscription = () => () => undefined;

const PUSH_MS = 350;
const STEP_IN = FadeIn.duration(tabsMotion.fade);
const STEP_OUT = FadeOut.duration(tabsMotion.fade);

const idleConnect = (): ConnectState<ConnectResult> => IDLE_CONNECT;

function PickedFolder({ name }: { name: string }) {
  const theme = useTheme();
  return (
    <View style={styles.added}>
      <Symbol name="folderFill" size={16} color={theme.secondaryLabel} />
      <Text style={[font.subheadline, styles.medium, { color: theme.secondaryLabel }]}>{name}</Text>
    </View>
  );
}

function Connecting() {
  const theme = useTheme();
  return (
    <View style={styles.added}>
      <ActivityIndicator size="small" color={theme.secondaryLabel} />
      <Text style={[font.subheadline, { color: theme.secondaryLabel }]}>Connecting…</Text>
    </View>
  );
}

function Problem({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text accessibilityLiveRegion="polite" style={[font.subheadline, { color: theme.destructive }]}>
      {text}
    </Text>
  );
}

function PhraseEntry({ initial, onUse, onBack }: { initial: string; onUse: (phrase: string) => void; onBack: () => void }) {
  const theme = useTheme();
  const [draft, setDraft] = useState(initial);
  const check = checkPhrase(draft);
  const footer = phraseFooter(check);
  useEffect(() => {
    if (check.isValid) haptics.success();
  }, [check.isValid]);
  const footerInk = footer.tone === "problem" ? theme.destructive : footer.tone === "good" ? theme.switchOn : theme.secondaryLabel;
  const use = () => {
    if (check.isValid) onUse(draft);
  };
  return (
    <SettingsPage title={t(`Enter Words`)} onBack={onBack} dismissesKeyboard={Platform.OS === "ios"} trailing={<BarButton title={t(`Use Phrase`)} emphasized enabled={check.isValid} onPress={use} />}>
      <View style={styles.phrase}>
        <View style={styles.phraseHeader}>
          <Text style={[font.footnote, styles.fill, { color: theme.secondaryLabel }]}>Recovery Phrase</Text>
          <CrossfadeText testID="phraseCounter" text={check.counterText} style={[font.footnote, styles.digits, { color: check.isTooLong ? theme.destructive : theme.secondaryLabel }]} />
        </View>
        <View style={[styles.field, { backgroundColor: theme.groupFill }]}>
          <TextInput
            accessibilityLabel={t(`Recovery Phrase`)}
            value={draft}
            onChangeText={setDraft}
            placeholder={t(`Enter your 24-word recovery phrase`)}
            placeholderTextColor={theme.tertiaryLabel}
            multiline
            autoFocus={!initial}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            spellCheck={false}
            keyboardType={Platform.OS === "android" ? "visible-password" : "ascii-capable"}
            textContentType="none"
            onSubmitEditing={use}
            style={[font.body, styles.phraseInput, { color: theme.label }]}
          />
        </View>
        <View accessibilityLiveRegion="polite" accessible accessibilityLabel={footer.text}>
          <CrossfadeText testID="phraseFooter" text={footer.text} style={[font.footnote, styles.footer, { color: footerInk }]} />
        </View>
      </View>
      {!draft ? (
        <View style={styles.paste}>
          <PasteAction onText={setDraft} />
        </View>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  fill: { flex: 1 },
  digits: { fontVariant: ["tabular-nums"] },
  step: { flexDirection: "row", gap: space.m, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.m },
  badge: { width: spacesLayout.stepBadge, height: spacesLayout.stepBadge, borderRadius: capsule(spacesLayout.stepBadge), borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  stepBody: { flex: 1, gap: space.xs },
  stepActions: { gap: space.s, paddingTop: space.xs },
  added: { flexDirection: "row", alignItems: "center", gap: space.s },
  phrase: { paddingHorizontal: space.l, gap: space.s },
  phraseHeader: { flexDirection: "row", paddingHorizontal: settingsLayout.rowInset },
  field: { borderRadius: radius.card, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.s },
  phraseInput: { minHeight: 140, textAlignVertical: "top", fontFamily: Platform.OS === "ios" ? t(`Menlo`) : "monospace" },
  footer: { paddingHorizontal: settingsLayout.rowInset },
  paste: { alignItems: "center", paddingHorizontal: space.huge },
  ways: { gap: space.s },
});
