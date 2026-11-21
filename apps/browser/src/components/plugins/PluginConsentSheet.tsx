import { useEffect, useRef, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { consentLines, isAlwaysOn } from "../../state/plugins/actions";
import { CONSENT_KEYS, CONSENT_KEYS_UP, consentKeyDown, consentKeyUp, FRESH_CONSENT_KEYS, type ConsentButton } from "../../state/plugins/consentKeys";
import { usePluginListing } from "../../state/plugins/hooks";
import type { PluginsStore } from "../../state/plugins/store";
import { Box, Button, DialogActions, DialogTitle, Sheet, Symbol, Text } from "../ui";
import { useTheme } from "../ui/theme";
import { ink, radius } from "../ui/tokens";
import { useControlTurnedOff } from "../../state/app/programControlSetting";
import { useNeverChosenCount } from "../../state/site/passwordManager";

type ConsentRequest = NonNullable<PluginsStore["consent"]>;

export function PluginConsentSheet({ request, onCancel, onConfirm, onClosed }: { request: ConsentRequest; onCancel: (id: number) => boolean; onConfirm: (id: number) => boolean; onClosed: () => void }) {
  const theme = useTheme();
  const { id, name, hash } = request;
  const listing = usePluginListing(name);
  const m = listing?.manifest;
  const controlOff = useControlTurnedOff();
  const movesProfiles = useNeverChosenCount();
  const install = isAlwaysOn(listing);
  const [selected, setSelected] = useState<ConsentButton | null>(null);
  const keyState = useRef(FRESH_CONSENT_KEYS);
  const keys = useRef<View>(null);
  useEffect(() => keys.current?.focus(), []);
  const close = () => {
    if (onCancel(id)) onClosed();
  };
  const confirm = () => {
    if (onConfirm(id)) onClosed();
  };
  const changed = !m || listing?.hash !== hash;
  return (
    <Sheet onClose={close} backdropCloses={false}>
      <View
        ref={keys}
        focusable
        enableFocusRing={false}
        keyDownEvents={CONSENT_KEYS}
        keyUpEvents={CONSENT_KEYS_UP}
        onKeyDown={(e) => {
          const next = consentKeyDown(keyState.current, e.nativeEvent, !changed);
          keyState.current = next.state;
          setSelected(next.state.selected);
          if (next.press === "cancel") close();
          else if (next.press === "install") confirm();
        }}
        onKeyUp={(e) => {
          keyState.current = consentKeyUp(keyState.current, e.nativeEvent);
        }}
        style={KEYS}
      >
        <DialogTitle icon={<Symbol name={m?.icon ?? "puzzlepiece.fill"} size={22} color={theme.icon} style={TITLE_ICON} />} subtitle={m?.description || undefined}>
          {`${install ? "Install" : "Turn on"} ${m?.title ?? name}?`}
        </DialogTitle>
        <ScrollView style={LINES}>
          <Box gap="s" pad="m">
            {changed ? (
              <Text tone="textSecondary">The plugin changed while this was open. Close this and try again.</Text>
            ) : (
              consentLines(m, { controlOff, bundled: !!listing?.bundled, movesProfiles }).map((line, index) => (
                <Box key={`${index}:${line.text}`} row gap="m">
                  <Symbol name={line.icon} size={13} color={theme.icon} style={ICON} />
                  <Text style={LINE}>{line.text}</Text>
                </Box>
              ))
            )}
          </Box>
        </ScrollView>
        <DialogActions>
          <Ring on={selected === "cancel"} color={theme.formAccent}>
            <Button title="Cancel" onPress={close} />
          </Ring>
          <Ring on={selected === "install"} color={theme.formAccent}>
            <Button title={install ? "Install" : "Turn On"} kind="primary" disabled={changed} onPress={confirm} />
          </Ring>
        </DialogActions>
      </View>
    </Sheet>
  );
}

function Ring({ on, color, children }: { on: boolean; color: string; children: ReactNode }) {
  return <View style={{ borderRadius: radius.control + RING * 2, borderWidth: RING, padding: RING, borderColor: on ? color : ink.clear, margin: -RING * 2 }}>{children}</View>;
}

const RING = 2;
const KEYS = { flexShrink: 1 } as const;
const LINES = { flexShrink: 1 } as const;
const LINE = { flex: 1 } as const;
const ICON = { width: 18, height: 18 } as const;
const TITLE_ICON = { width: 28, height: 28 } as const;
