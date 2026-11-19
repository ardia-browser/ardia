import { ScrollView } from "react-native";
import { consentLines, isAlwaysOn } from "../../state/plugins/actions";
import { usePluginListing } from "../../state/plugins/hooks";
import type { PluginsStore } from "../../state/plugins/store";
import { Box, Button, DialogActions, DialogTitle, Sheet, Symbol, Text } from "../ui";
import { useTheme } from "../ui/theme";

type ConsentRequest = NonNullable<PluginsStore["consent"]>;

export function PluginConsentSheet({ request, onCancel, onConfirm, onClosed }: { request: ConsentRequest; onCancel: (id: number) => boolean; onConfirm: (id: number) => boolean; onClosed: () => void }) {
  const theme = useTheme();
  const { id, name, hash } = request;
  const listing = usePluginListing(name);
  const m = listing?.manifest;
  const install = isAlwaysOn(listing);
  const close = () => {
    if (onCancel(id)) onClosed();
  };
  const changed = !m || listing?.hash !== hash;
  return (
    <Sheet onClose={close} backdropCloses={false} closesOnEscape>
      <DialogTitle icon={<Symbol name={m?.icon ?? "puzzlepiece.fill"} size={22} color={theme.icon} style={TITLE_ICON} />} subtitle={m?.description || undefined}>
        {`${install ? "Install" : "Turn on"} ${m?.title ?? name}?`}
      </DialogTitle>
      <ScrollView style={LINES}>
        <Box gap="s" pad="m">
          {changed ? (
            <Text tone="textSecondary">The plugin changed while this was open. Close this and try again.</Text>
          ) : (
            consentLines(m).map((line, index) => (
              <Box key={`${index}:${line.text}`} row gap="m">
                <Symbol name={line.icon} size={13} color={theme.icon} style={ICON} />
                <Text style={LINE}>{line.text}</Text>
              </Box>
            ))
          )}
        </Box>
      </ScrollView>
      <DialogActions>
        <Button title="Cancel" onPress={close} />
        <Button
          title={install ? "Install" : "Turn On"}
          kind="primary"
          disabled={changed}
          onPress={() => {
            if (onConfirm(id)) onClosed();
          }}
        />
      </DialogActions>
    </Sheet>
  );
}

const LINES = { flexShrink: 1 } as const;
const LINE = { flex: 1 } as const;
const ICON = { width: 18, height: 18 } as const;
const TITLE_ICON = { width: 28, height: 28 } as const;
