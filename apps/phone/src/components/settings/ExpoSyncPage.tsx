import { useEffect, useRef, useState } from "react";
import { PlatformColor } from "react-native";
import { Button, ConfirmationDialog, Form, HStack, Image, Label, LabeledContent, NavigationLink, ProgressView, Section, Spacer, Text, TextField, useNativeState } from "@expo/ui/swift-ui";
import { accessibilityElement, accessibilityHidden, buttonBorderShape, buttonStyle, controlSize, disabled, font, foregroundStyle, frame, padding, refreshable, submitLabel, textInputAutocapitalization, tint } from "@expo/ui/swift-ui/modifiers";
import { copy } from "../../lib/platformCopy";
import { haptics } from "../../state/app/haptics";
import { settingsRouteKey, pushSettings } from "../../state/settings/nav";
import { acknowledgeSyncReset, changeSyncFolder, setDeviceName, stopSyncing, syncNow } from "../../state/sync/actions";
import { useSyncStatus, useSyncView } from "../../state/sync/hooks";
import { useSync } from "../../state/sync/store";
import { connectMessage, deviceIcon, deviceSeen, inboxNotice, isSyncConnected, isSyncOff, orderedDevices, sendReceivers, shownProfile, syncHeroSubtitle, syncNowFeedback } from "../../state/sync/syncRules";
import { modifierList, settingsChrome, settingsPage, useTheme } from "../ui";
import { ExpoHero } from "./ExpoSettingsParts";
import { t } from "../../lib/uiLanguage";


const FILL = Number.MAX_SAFE_INTEGER;
const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const NAME_SETTLE_MS = 600;
const DEVICE_SYMBOLS = { phone: "iphone", laptop: "laptopcomputer", desktop: "desktopcomputer", studio: "macstudio", mini: "macmini" } as const;
const FEATURES = [
  { symbol: "macbook", title: t(`Your Mac’s Tabs`) },
  { symbol: "pin.fill", title: t(`Pinned Tabs and Spaces`) },
  { symbol: "paperplane.fill", title: t(`Send Tabs Both Ways`) },
  { symbol: "clock.arrow.circlepath", title: t(`History and Bookmarks`) },
] as const;

export function ExpoSyncPage() {
  const status = useSyncStatus();
  const view = useSyncView();
  const theme = useTheme();
  const [syncing, setSyncing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const off = isSyncOff(status);
  const hero = syncHeroSubtitle(status);
  const notice = inboxNotice(status);
  const devices = orderedDevices(view.devices);
  const noReceivers = sendReceivers(view, shownProfile(view, status)?.syncId ?? null).length === 0;
  const now = Date.now();
  const chooseFolder = async () => setFolderError(connectMessage(await changeSyncFolder()));
  const runSyncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    await syncNow();
    setSyncing(false);
    const feedback = syncNowFeedback(useSync.getState().status.phase);
    if (feedback) haptics[feedback]();
  };
  const stop = async () => {
    haptics.warning();
    setStopping(true);
    await stopSyncing();
    setStopping(false);
  };
  return (
    <Form modifiers={modifierList(settingsPage(t(`Sync With Mac`)), tint(PlatformColor("systemBlue")), settingsChrome(), status.isEnabled ? refreshable(syncNow) : null)}>
      <ExpoHero title={t(`Sync With Mac`)} subtitle={hero.text} warning={hero.isWarning} systemImage="macbook.and.iphone" tint="sync">
        {off ? (
          <Button onPress={() => pushSettings({ page: "syncConnect" })} modifiers={[buttonStyle("borderedProminent"), buttonBorderShape("roundedRectangle", 12), controlSize("large"), tint(theme.primaryAction), foregroundStyle(theme.onPrimaryAction), padding({ top: 8 })]}>
            <Text modifiers={[frame({ maxWidth: FILL })]}>Connect to Your Mac</Text>
          </Button>
        ) : null}
      </ExpoHero>
      {off ? (
        <Section title={t(`What You Get`)} footer={<Text>{copy().syncFeatureFooter}</Text>}>
          {FEATURES.map((feature) => (
            <HStack key={feature.symbol} alignment="firstTextBaseline" spacing={12} modifiers={[padding({ vertical: 2 }), accessibilityElement("combine")]}>
              <Image systemName={feature.symbol} modifiers={[font({ textStyle: "body", weight: "semibold" }), foregroundStyle(theme.formAccent), frame({ width: 28 }), accessibilityHidden(true)]} />
              <Text>{feature.title}</Text>
            </HStack>
          ))}
        </Section>
      ) : null}
      {notice ? (
        <Section footer={notice.footer ? <Text>{notice.footer}</Text> : undefined}>
          <Label title={notice.message} systemImage="exclamationmark.triangle.fill" />
        </Section>
      ) : null}
      {status.attention === "folder" ? (
        <Section footer={<Text>Choose the Ardia Sync folder again.</Text>}>
          <Button label={t(`Choose Folder…`)} onPress={() => void chooseFolder()} />
        </Section>
      ) : null}
      {status.attention === "phrase" ? (
        <Section>
          <NavigationLink value={settingsRouteKey({ page: "syncConnect" })}>
            <Text>Enter Recovery Phrase</Text>
          </NavigationLink>
        </Section>
      ) : null}
      {status.attention === "reset" ? (
        <Section footer={<Text>{copy().syncTabsStay}</Text>}>
          <Button onPress={() => void acknowledgeSyncReset().then(() => pushSettings({ page: "syncConnect" }))} modifiers={[tint("primary")]}>
            <HStack>
              <Text>Connect Again</Text>
              <Spacer />
              <Image systemName="chevron.right" modifiers={[font({ textStyle: "footnote", weight: "semibold" }), foregroundStyle({ type: "hierarchical", style: "tertiary" })]} />
            </HStack>
          </Button>
        </Section>
      ) : null}
      {isSyncConnected(status) ? (
        <>
          <Section>
            <Button onPress={() => void runSyncNow()} modifiers={[disabled(syncing)]}>
              <HStack>
                <Text>{syncing ? t(`Syncing…`) : t(`Sync Now`)}</Text>
                <Spacer />
                {syncing ? <ProgressView /> : null}
              </HStack>
            </Button>
          </Section>
          {devices.length ? (
            <Section title={t(`Devices`)} footer={noReceivers ? <Text>Update Ardia on your Mac to send tabs to it.</Text> : undefined}>
              {devices.map((device) => {
                const seen = deviceSeen(device, now);
                return (
                  <LabeledContent key={device.id} label={<Label title={device.name} icon={<Image systemName={DEVICE_SYMBOLS[deviceIcon(device.kind, device.name)]} modifiers={[foregroundStyle(SECONDARY)]} />} />}>
                    {seen ? <Text>{seen}</Text> : null}
                  </LabeledContent>
                );
              })}
            </Section>
          ) : null}
          <DeviceName current={status.deviceName} />
          <Section title={t(`Sync Folder`)} footer={folderError ? <Text modifiers={[foregroundStyle(theme.destructive)]}>{folderError}</Text> : <Text>Encrypted so only your devices can read it.</Text>}>
            <LabeledContent label={t(`Folder`)}>
              <Text>{status.folderName ?? t(`Ardia Sync`)}</Text>
            </LabeledContent>
            <Button label={t(`Change Folder…`)} onPress={() => void chooseFolder()} />
          </Section>
          <Section footer={<Text>{copy().stopSyncingFooter}</Text>}>
            <ConfirmationDialog title={t(`Stop Syncing This Device?`)} isPresented={confirmingStop} onIsPresentedChange={setConfirmingStop} titleVisibility="visible">
              <ConfirmationDialog.Trigger>
                <Button role="destructive" onPress={() => setConfirmingStop(true)} modifiers={[disabled(stopping)]}>
                  <HStack>
                    <Text>Stop Syncing…</Text>
                    <Spacer />
                    {stopping ? <ProgressView /> : null}
                  </HStack>
                </Button>
              </ConfirmationDialog.Trigger>
              <ConfirmationDialog.Actions>
                <Button role="destructive" label={t(`Stop Syncing`)} onPress={() => void stop()} />
              </ConfirmationDialog.Actions>
              <ConfirmationDialog.Message>
                <Text>To sync again, you’ll need your Mac’s code or your recovery phrase.</Text>
              </ConfirmationDialog.Message>
            </ConfirmationDialog>
          </Section>
        </>
      ) : null}
    </Form>
  );
}

function DeviceName({ current }: { current: string }) {
  const text = useNativeState(current);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);
  const save = () => {
    const trimmed = pending.current?.trim();
    pending.current = null;
    if (trimmed && trimmed !== current) setDeviceName(trimmed);
  };
  const latestSave = useRef(save);
  latestSave.current = save;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      latestSave.current();
    },
    [],
  );
  const change = (next: string) => {
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => latestSave.current(), NAME_SETTLE_MS);
  };
  return (
    <Section title={copy().deviceNameHeader} footer={<Text>Shown on your Mac.</Text>}>
      <TextField text={text} placeholder={t(`Name`)} onTextChange={change} modifiers={[textInputAutocapitalization("words"), submitLabel("done")]} />
    </Section>
  );
}
