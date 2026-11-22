import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { copyText } from "../../../state/app/system";
import { installOfficialPlugin, UNSAVED, type OfficialPlugin } from "../../../state/plugins/actions";
import { useOfficialFetch, useOfficialPlugins, usePluginConsent, usePluginOrder, usePluginPrograms, usePluginUnsaved } from "../../../state/plugins/hooks";
import { installedLabel, isOffered, officialInSettings, officialTitle, officialView, wasCancelled, type OfficialAttempt } from "../../../state/plugins/officialView";
import { OFFICIAL_LEGACY_PROGRAMS } from "../../../state/plugins/officialPin";
import { refreshLegacyInstalls, useLegacyInstalls } from "../../../state/plugins/programRegistry";
import { goToSettingsPane } from "../../../state/settings/settingsWindows";
import { consentToken, noteOfficialPlugin } from "../../../state/telemetry/officialPluginCounts";
import { Group, Row, SectionHeader } from "../Form";
import { findSetting, type SettingId } from "../settingsIndex";
import { officialPluginAnchor } from "../rows/pluginRows";
import { ActivitySpinner, Button, IconTile, Text } from "../../ui";
import { lineHeight, monoFace, space } from "../../ui/tokens";

const COPIED_FOR_MS = 2000;

export function usePluginsBelowOfficial(): string[] {
  const order = usePluginOrder();
  const official = useOfficialPlugins();
  return useMemo(() => order.filter((name) => !official.some((o) => o.name === name && o.state !== "unsupported")), [order, official]);
}

export function OfficialPluginsSection() {
  const all = useOfficialPlugins();
  const plugins = all.filter((p) => officialInSettings([p]));
  useEffect(() => void refreshLegacyInstalls(), []);
  if (!officialInSettings(all)) return null;
  return (
    <View>
      <SectionHeader anchor="plugins.official" description={null} />
      <Group>
        {plugins.map((plugin) => (
          <OfficialPluginRow key={plugin.name} plugin={plugin} />
        ))}
      </Group>
    </View>
  );
}

function useInstall(plugin: OfficialPlugin) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const asking = usePluginConsent()?.name === plugin.name;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const install = async () => {
    if (busy) return;
    const consent = consentToken();
    setBusy(true);
    setFailure(null);
    const result = await installOfficialPlugin(plugin.name, { showSheet: false });
    if (!wasCancelled(result)) noteOfficialPlugin("settings", result.ok ? "installed" : "failed", plugin.name, consent);
    if (!mounted.current) return;
    setBusy(false);
    setFailure(result.ok || wasCancelled(result) ? null : result.reason);
  };
  const unsaved = usePluginUnsaved(plugin.name);
  const attempt: OfficialAttempt = busy ? { state: asking ? "asking" : "installing" } : failure ? { state: "failed", reason: failure } : unsaved ? { state: "failed", reason: UNSAVED } : null;
  return { attempt, install };
}

function OfficialPluginRow({ plugin }: { plugin: OfficialPlugin }) {
  const programs = usePluginPrograms(plugin.name);
  const { attempt, install } = useInstall(plugin);
  const fetch = useOfficialFetch(plugin.name);
  const legacy = useLegacyInstalls((s) => s.owners.includes(plugin.name));
  const olderProgram = legacy && Object.hasOwn(OFFICIAL_LEGACY_PROGRAMS, plugin.name) ? OFFICIAL_LEGACY_PROGRAMS[plugin.name]! : null;
  const view = officialView(plugin, programs, attempt, fetch, olderProgram);
  const offered = isOffered(plugin);
  useEffect(() => {
    if (offered) noteOfficialPlugin("settings", "shown", plugin.name);
  }, [plugin.name, offered]);
  const anchor = findSetting(officialPluginAnchor(plugin.name))?.id as SettingId | undefined;
  return (
    <Row
      anchor={anchor}
      title={
        <View style={TITLE}>
          <Text>{officialTitle(plugin)}</Text>
          {view.note === "installed" ? (
            <Text size="caption" tone="textSecondary">
              {installedLabel(plugin)}
            </Text>
          ) : null}
        </View>
      }
      icon={<IconTile symbol={plugin.icon} size="l" />}
      onPress={view.opens ? () => goToSettingsPane("plugins", null, plugin.name) : undefined}
      description={
        view.note === "comingSoon" ? undefined : (
          <Text selectable={view.failed} lines={view.failed ? undefined : 2} size="caption" tone={view.failed ? "destructive" : "textSecondary"} style={LINE}>
            {view.status ?? plugin.blurb}
          </Text>
        )
      }
    >
      {view.busy && view.status ? <ActivitySpinner style={SPINNER} /> : null}
      {view.note === "comingSoon" ? (
        <Text size="small" tone="textTertiary">
          Coming soon
        </Text>
      ) : null}
      {view.firstCommand ? <FirstCommand command={view.firstCommand} /> : null}
      {view.action === "install" || (view.busy && !view.status) ? (
        <Button title="Install…" disabled={view.busy} onPress={() => void install()} />
      ) : null}
      {view.action === "again" ? <Button title="Try Again" onPress={() => void install()} /> : null}
      {view.action === "update" ? <Button title="Update…" onPress={() => void install()} /> : null}
    </Row>
  );
}

function FirstCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FOR_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <View style={COMMAND}>
      <Text selectable size="small" tone="textSecondary" style={monoFace()}>
        {command}
      </Text>
      <Button
        title={copied ? "Copied" : "Copy"}
        onPress={() => {
          copyText(command);
          setCopied(true);
        }}
      />
    </View>
  );
}

const TITLE = { flexDirection: "row", alignItems: "baseline", gap: space.s } as const;
const LINE = { marginTop: space.xxs, lineHeight: lineHeight.caption } as const;
const SPINNER = { width: 14, height: 14 } as const;
const COMMAND = { flexDirection: "row", alignItems: "center", gap: space.m } as const;
