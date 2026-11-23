import { CastMode, preferredCastMode, startCasting, stopCasting, type CastSink, closeCastPicker, useCast } from "../../state/media/cast";
import { openExternalURL, showMenu } from "../../state/app/system";
import { ActivitySpinner, Symbol, Button, MenuRow, PANEL, PanelHeader, Popover, POPOVER_MARGIN, POPOVER_WIDTH, PopoverValue, Text, usePopoverPresenceOf, useStillOpen, whileOpen } from "../ui";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useTheme } from "../ui/theme";
import { space } from "../ui/tokens";
import { PLATFORM_TERMS } from "../../lib/platformTerms";

const FLEX = { flex: 1 } as const;

const SINK_ICON: Record<number, string> = { 0: "tv", 1: "hifispeaker.2", 2: "hifispeaker", 6: "display", 7: "tv" };

export function CastPicker({ tabId, paneWidth }: { tabId: string; paneWidth: number }) {
  const theme = useTheme();
  const { shown: dialog, closing, onClosed } = usePopoverPresenceOf(useCast((c) => c.dialogs[tabId]) ?? null);
  const [screen, setScreen] = useState(false);
  useEffect(() => setScreen(false), [dialog?.id]);
  const stillOpen = useStillOpen(!closing);
  if (!dialog) return null;
  const act = whileOpen(closing, stillOpen);
  const close = act(() => closeCastPicker(tabId));
  const available = dialog.sinks.filter((s) => s.state !== "unavailable");
  const canScreen = dialog.sinks.some((s) => s.modes & CastMode.screen);
  const width = Math.min(POPOVER_WIDTH.m, paneWidth - 24);
  const cast = act((sink: CastSink) => {
    const mode = screen && sink.modes & CastMode.screen ? CastMode.screen : preferredCastMode(sink.modes & ~CastMode.screen) || preferredCastMode(sink.modes);
    if (mode) void startCasting(dialog.id, sink.id, mode);
  });
  const stop = act((sink: CastSink) => void stopCasting(dialog.id, sink.routeId));

  return (
    <Popover key={dialog.id} width={width} top={POPOVER_MARGIN} right={POPOVER_MARGIN} onDismiss={close} closing={closing} onClosed={onClosed}>
      <View style={{ paddingBottom: PANEL.inset }}>
        <PanelHeader
          icon={<Symbol name="tv.and.mediabox" size={14} color={theme.icon} style={{ width: PANEL.iconSlot, height: PANEL.iconSlot }} />}
          title={screen ? "Cast screen" : dialog.header || "Cast tab"}
          accessory={canScreen ? <SourceButton screen={screen} onChange={act(setScreen)} /> : null}
        />

        {dialog.permissionRejected ? (
          <Message
            text={PLATFORM_TERMS.localNetworkSettingsUrl ? "Ardia needs Local Network access to find Cast devices." : "Ardia can't reach the local network to find Cast devices."}
            link={PLATFORM_TERMS.localNetworkSettingsUrl ? "Open Local Network Settings" : null}
            onLink={act(() => void openExternalURL(PLATFORM_TERMS.localNetworkSettingsUrl))}
          />
        ) : available.length ? (
          <ScrollView style={{ maxHeight: 280 }} contentContainerStyle={{ gap: space.xxs }}>
            {available.map((sink) => (
              <SinkRow key={sink.id} sink={sink} onCast={() => cast(sink)} onStop={() => stop(sink)} />
            ))}
          </ScrollView>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: PANEL.inset, paddingTop: space.xs, paddingBottom: space.xs }}>
            <ActivitySpinner style={SPINNER} />
            <Text size="small" tone="textSecondary" style={FLEX}>
              {`Looking for devices… Cast devices need to be on the same Wi‑Fi network as this ${PLATFORM_TERMS.computer}.`}
            </Text>
          </View>
        )}

        <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: PANEL.inset, marginTop: space.ml }}>
          <Button variant="pill" title="Done" onPress={close} />
        </View>
      </View>
    </Popover>
  );
}

const SPINNER = { width: 14, height: 14 } as const;

function SinkRow({ sink, onCast, onStop }: { sink: CastSink; onCast(): void; onStop(): void }) {
  const theme = useTheme();
  const active = sink.state === "connected" && !!sink.routeId;
  const busy = sink.state === "connecting" || sink.state === "disconnecting";
  return (
    <MenuRow
      icon={SINK_ICON[sink.icon] ?? "tv"}
      iconColor={active ? theme.accent : undefined}
      title={sink.name}
      detail={sink.issue || sink.status || undefined}
      detailColor={sink.issue ? theme.destructive : undefined}
      onPress={active || busy ? undefined : onCast}
      accessory={busy ? <ActivitySpinner style={SPINNER} /> : active ? <Button variant="pill" title="Stop" onPress={onStop} /> : null}
    />
  );
}

function SourceButton({ screen, onChange }: { screen: boolean; onChange: (screen: boolean) => void }) {
  const pick = async () => {
    const choice = await showMenu([
      { id: "tab", title: "Cast Tab", checked: !screen },
      { id: "screen", title: "Cast Screen", checked: screen },
    ]);
    if (choice) onChange(choice === "screen");
  };
  return <PopoverValue title="Sources" chevron="chevron.down" tooltip="Source" onPress={() => void pick()} />;
}

function Message({ text, link, onLink }: { text: string; link: string | null; onLink: () => void }) {
  return (
    <View style={{ paddingHorizontal: PANEL.inset, paddingTop: space.xs, gap: space.xs, alignItems: "flex-start" }}>
      <Text size="small" tone="textSecondary">{text}</Text>
      {link ? <Button variant="text" look="link" tone="textPrimary" title={link} onPress={onLink} /> : null}
    </View>
  );
}
