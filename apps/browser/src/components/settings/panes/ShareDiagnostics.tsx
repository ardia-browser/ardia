import { useEffect, useState } from "react";
import { View } from "react-native";
import { setSharing, useTelemetry } from "../../../state/telemetry/client";
import { IDENTITY_COPY, LOCAL_COPY, PLUGIN_SENT_COPY, SELF_INSTALLED_COMMAND_SENT, SHARING_COPY, WATCH_COPY, WHATS_SENT } from "../../../state/telemetry/copy";
import { usePluginTelemetryDisclosures } from "../../../state/plugins/disclosures";
import { refreshLegacyInstalls } from "../../../state/plugins/programRegistry";
import { installsCommandItself } from "../../../state/app/linuxCommandInstall";
import { identityFor, resetAnonymousId, shortInstallId, stopWatch, useInstallId, useWatchReport, useWatchTurnedSharingOn, useWatchUntil, viewMyData } from "../../../state/telemetry/privacy";
import { UI_LOCALE } from "../../../lib/uiLocale";
import { Button, DialogActions, DialogTitle, lineHeight, proseLineHeight, Sheet, space, Text, Toggle } from "../../ui";
import { Group, Row, SectionHeader } from "../Form";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { AnonymousAvatar } from "../AnonymousAvatar";
import { perLook } from "../../ui/tokens";

const AVATAR_SIZE = 28;

const longDate = (ms: number) => new Date(ms).toLocaleDateString(UI_LOCALE, { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

export function ShareDiagnosticsToggle() {
  const sharing = useTelemetry((s) => s.sharing);
  return (
    <Row anchor="general.shareDiagnostics" description={SHARING_COPY.summary}>
      <Toggle value={sharing} accessibilityLabel={SHARING_COPY.toggle} onChange={(on) => setSharing(on, "settings")} />
    </Row>
  );
}

export function ShareDiagnosticsSection() {
  return (
    <>
      <SectionHeader title="Crash reports and usage" description={SHARING_COPY.dailyCountShort} />
      <Group>
        <ShareDiagnosticsToggle />
        <Row title={SHARING_COPY.whatsSent} onPress={() => showSettingsSheet(<WhatsSentSheet />)} />
      </Group>
    </>
  );
}

export function CrashReportDetails() {
  const report = useWatchReport();
  const until = useWatchUntil();
  return (
    <View>
      <SectionHeader title="Your anonymous ID" description={SHARING_COPY.dailyCountShort} />
      <Group>
        {report && until !== null ? <WatchRow report={report} until={until} /> : null}
        <IdentityRow />
      </Group>
      <KeptOnThisMac />
      <SectionHeader title={SHARING_COPY.whatsSent} description={`Only while “${SHARING_COPY.toggle}” is on, except what’s under “Even with sharing off” and “${SHARING_COPY.keptOnThisMac}”.`} />
      <WhatsSentGroups />
      <Text size="caption" tone="textTertiary" style={DETAILS_FOOTNOTE()}>
        {SHARING_COPY.footnote}
      </Text>
    </View>
  );
}

function WatchRow({ report, until }: { report: string; until: number }) {
  const turnedSharingOn = useWatchTurnedSharingOn();
  const detail = turnedSharingOn ? WATCH_COPY.rowDetail(report, longDate(until)) : WATCH_COPY.rowDetailAlreadySharing(report, longDate(until));
  return (
    <Row title={WATCH_COPY.rowTitle} description={detail}>
      <Button title={WATCH_COPY.stop} onPress={stopWatch} />
    </Row>
  );
}

function IdentityRow() {
  const installId = useInstallId();
  if (!installId) return <Row title={IDENTITY_COPY.noId} description={IDENTITY_COPY.noIdDetail} />;
  const { name, avatar } = identityFor(installId);
  return (
    <Row icon={<AnonymousAvatar avatar={avatar} size={AVATAR_SIZE} />} title={IDENTITY_COPY.appearAs(name)} description={IDENTITY_COPY.idDetail(shortInstallId(installId))}>
      <Button title={IDENTITY_COPY.reset} onPress={() => showSettingsSheet(<ResetIdSheet />)} />
    </Row>
  );
}

function KeptOnThisMac() {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const result = await viewMyData();
    setBusy(false);
    setStatus(result ? LOCAL_COPY.exported(result.lines) : LOCAL_COPY.exportFailed);
  };
  return (
    <>
      <SectionHeader title={LOCAL_COPY.title} description={LOCAL_COPY.summary} />
      <Group>
        <Row title={LOCAL_COPY.viewData} description={status ?? LOCAL_COPY.viewDataDetail}>
          <Button title={LOCAL_COPY.viewData} disabled={busy} onPress={() => void save()} />
        </Row>
      </Group>
    </>
  );
}

function ResetIdSheet() {
  const [done, setDone] = useState<string | null>(null);
  const reset = async () => {
    const installId = await resetAnonymousId();
    setDone(identityFor(installId).name);
  };
  return (
    <Sheet size="s" onClose={closeSettingsSheet}>
      <DialogTitle subtitle={done ? IDENTITY_COPY.resetDone(done) : IDENTITY_COPY.resetBody}>{IDENTITY_COPY.resetTitle}</DialogTitle>
      <DialogActions>
        {done ? (
          <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
        ) : (
          <>
            <Button title="Cancel" onPress={closeSettingsSheet} />
            <Button title={IDENTITY_COPY.resetConfirm} kind="destructive" onPress={() => void reset()} />
          </>
        )}
      </DialogActions>
    </Sheet>
  );
}

type SentGroup = { title: string; attribution?: string; items: readonly string[] };

function WhatsSentGroups() {
  const disclosures = usePluginTelemetryDisclosures();
  const toGroup = (d: (typeof disclosures)[number]): SentGroup => ({ title: d.title, attribution: PLUGIN_SENT_COPY.attribution(d.pluginTitle, d.official), items: d.items });
  const added = disclosures.filter((d) => !d.official).map(toGroup);
  const programs: SentGroup[] = [...(installsCommandItself ? [SELF_INSTALLED_COMMAND_SENT] : []), ...disclosures.filter((d) => d.official).map(toGroup)];
  const sharingOff = WHATS_SENT.findIndex((g) => g.title === "Even with sharing off");
  const browser: SentGroup[] = sharingOff < 0 ? WHATS_SENT.slice(0, -1) : [...WHATS_SENT.slice(0, sharingOff), ...programs, ...WHATS_SENT.slice(sharingOff, -1)];
  const groups: SentGroup[] = [...browser, { title: SHARING_COPY.keptOnThisMac, items: [...LOCAL_COPY.items] }, WHATS_SENT.at(-1)!];
  return (
    <>
      {[...groups, ...(added.length ? [{ title: PLUGIN_SENT_COPY.addedTitle, heading: true, attribution: PLUGIN_SENT_COPY.addedNote, items: [] }] : []), ...added].map((group: SentGroup & { heading?: boolean }) => group.heading ? (
        <View key={group.title} style={SENT_GROUP}>
          <Text size="small" weight="semibold" tone="textPrimary" style={SENT_TITLE}>
            {group.title}
          </Text>
          <Text size="caption" tone="textSecondary" style={SENT_TITLE}>
            {group.attribution}
          </Text>
        </View>
      ) : (
        <View key={group.title} style={SENT_GROUP}>
          <Text size="small" weight="medium" tone="textSecondary" style={SENT_TITLE}>
            {group.title}
          </Text>
          {group.attribution ? (
            <Text size="caption" tone="textTertiary" style={SENT_TITLE}>
              {group.attribution}
            </Text>
          ) : null}
          <Group>
            {group.items.map((item) => (
              <Row
                key={item}
                title={
                  <Text size="small" style={ITEM()}>
                    {item}
                  </Text>
                }
              />
            ))}
          </Group>
        </View>
      ))}
    </>
  );
}

export function WhatsSentSheet() {
  useEffect(() => void refreshLegacyInstalls(), []);
  return (
    <Sheet size="l" onClose={closeSettingsSheet}>
      <DialogTitle subtitle={`Only while “${SHARING_COPY.toggle}” is on, except what’s under “Even with sharing off”, “${SHARING_COPY.keptOnThisMac}” and “${PLUGIN_SENT_COPY.addedTitle}”.`}>{SHARING_COPY.whatsSent}</DialogTitle>
      <WhatsSentGroups />
      <DialogActions
        note={
          <Text size="caption" tone="textTertiary" style={FOOTNOTE()}>
            {SHARING_COPY.footnote}
          </Text>
        }
      >
        <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
      </DialogActions>
    </Sheet>
  );
}

const SENT_GROUP = { marginTop: space.l } as const;
const SENT_TITLE = { marginBottom: space.s, paddingHorizontal: space.xxs } as const;
const ITEM = perLook(() => ({ lineHeight: proseLineHeight.small }) as const);
const FOOTNOTE = perLook(() => ({ lineHeight: lineHeight.caption }) as const);
const DETAILS_FOOTNOTE = perLook(() => ({ marginTop: space.l, lineHeight: lineHeight.caption }) as const);
