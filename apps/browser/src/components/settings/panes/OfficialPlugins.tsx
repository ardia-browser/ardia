import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { copyText } from "../../../state/app/system";
import { installOfficialPlugin, type OfficialPlugin } from "../../../state/plugins/actions";
import { useOfficialPlugins, usePluginConsent, usePluginOrder, usePluginPrograms } from "../../../state/plugins/hooks";
import { isOffered, officialTitle, officialView, wasCancelled, type OfficialAttempt } from "../../../state/plugins/officialView";
import { goToSettingsPane } from "../../../state/settings/settingsWindows";
import { consentToken, noteOfficialPlugin } from "../../../state/telemetry/officialPluginCounts";
import { Group, Row, SectionHeader } from "../Form";
import type { SettingId } from "../settingsIndex";
import { ActivitySpinner, Button, IconTile, Text } from "../../ui";
import { lineHeight, monoFace, space } from "../../ui/tokens";

const ROW_ANCHORS: Record<string, SettingId> = { cli: "plugins.commandLine" };
const COPIED_FOR_MS = 2000;

export function usePluginsBelowOfficial(): string[] {
  const order = usePluginOrder();
  const official = useOfficialPlugins();
  return useMemo(() => order.filter((name) => !official.some((o) => o.name === name && o.state !== "unsupported")), [order, official]);
}

export function OfficialPluginsSection() {
  const plugins = useOfficialPlugins().filter((p) => p.state !== "unsupported");
  if (!plugins.length) return null;
  return (
    <View>
      <SectionHeader anchor="plugins.official" />
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
    setFailure(result.ok || wasCancelled(result) ? null : (result.reason ?? "Something went wrong."));
  };
  const attempt: OfficialAttempt = busy ? { state: asking ? "asking" : "installing" } : failure ? { state: "failed", reason: failure } : null;
  return { attempt, install };
}

function OfficialPluginRow({ plugin }: { plugin: OfficialPlugin }) {
  const programs = usePluginPrograms(plugin.name);
  const { attempt, install } = useInstall(plugin);
  const view = officialView(plugin, programs, attempt);
  const offered = isOffered(plugin);
  useEffect(() => {
    if (offered) noteOfficialPlugin("settings", "shown", plugin.name);
  }, [plugin.name, offered]);
  const title = `${officialTitle(plugin)}${view.note === "installed" && plugin.version ? ` ${plugin.version}` : ""}`;
  const anchor = ROW_ANCHORS[plugin.name];
  return (
    <Row
      anchor={anchor}
      title={title}
      icon={<IconTile symbol={plugin.icon} size="l" />}
      onPress={view.opens ? () => goToSettingsPane("plugins", null, plugin.name) : undefined}
      description={
        <View style={DETAIL}>
          <Text size="caption" tone="textSecondary" style={LINE}>
            {plugin.blurb}
          </Text>
          {view.status ? (
            <Text selectable size="caption" tone={view.failed ? "destructive" : "textSecondary"} style={LINE}>
              {view.status}
            </Text>
          ) : view.note === "installed" ? (
            <Text size="caption" tone="textSecondary" style={LINE}>
              Installed. It stays on.
            </Text>
          ) : null}
          {view.firstCommand ? <FirstCommand command={view.firstCommand.command} does={view.firstCommand.does} /> : null}
        </View>
      }
    >
      {view.busy && view.status ? <ActivitySpinner style={SPINNER} /> : null}
      {view.note === "comingSoon" ? (
        <Text size="small" tone="textTertiary">
          Coming soon
        </Text>
      ) : null}
      {view.action === "install" || (view.busy && !view.status) ? <Button title="Install…" disabled={view.busy} onPress={() => void install()} /> : null}
      {view.action === "again" ? <Button title="Try Again" onPress={() => void install()} /> : null}
    </Row>
  );
}

function FirstCommand({ command, does }: { command: string; does: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FOR_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <View style={COMMAND}>
      <Text selectable size="caption" style={[monoFace(), COMMAND_TEXT]}>
        {command}
      </Text>
      <Text size="caption" tone="textSecondary" style={COMMAND_NOTE}>
        {does}
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

const DETAIL = { marginTop: space.xxs, gap: space.xxs } as const;
const LINE = { lineHeight: lineHeight.caption } as const;
const SPINNER = { width: 14, height: 14 } as const;
const COMMAND = { flexDirection: "row", alignItems: "center", gap: space.m, marginTop: space.s } as const;
const COMMAND_TEXT = { flexShrink: 0 } as const;
const COMMAND_NOTE = { flex: 1 } as const;
