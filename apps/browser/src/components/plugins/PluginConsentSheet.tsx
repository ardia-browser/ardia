import { consentLines, dismissPluginConsent, enablePlugin, isAlwaysOn } from "../../state/plugins/actions";
import { usePluginListing } from "../../state/plugins/hooks";
import { Box, Button, DialogActions, DialogTitle, Sheet, Symbol, Text } from "../ui";
import { useTheme } from "../ui/theme";

export function PluginConsentSheet({ name, hash, onClosed, confirm = enablePlugin }: { name: string; hash: string; onClosed: () => void; confirm?: (name: string, hash: string) => boolean }) {
  const theme = useTheme();
  const listing = usePluginListing(name);
  const m = listing?.manifest;
  const install = isAlwaysOn(listing);
  const close = () => {
    if (dismissPluginConsent(name)) onClosed();
  };
  const changed = !m || listing?.hash !== hash;
  return (
    <Sheet onClose={close}>
      <DialogTitle icon={<Symbol name={m?.icon ?? "puzzlepiece.fill"} size={22} color={theme.icon} style={TITLE_ICON} />} subtitle={m?.description || undefined}>
        {`${install ? "Install" : "Turn on"} ${m?.title ?? name}?`}
      </DialogTitle>
      <Box gap="s" pad="m">
        {changed ? (
          <Text tone="textSecondary">The plugin changed while this was open. Close this and try again.</Text>
        ) : (
          consentLines(m).map((line) => (
            <Box key={line.text} row gap="m">
              <Symbol name={line.icon} size={13} color={theme.icon} style={ICON} />
              <Text style={LINE}>{line.text}</Text>
            </Box>
          ))
        )}
      </Box>
      <DialogActions>
        <Button title="Cancel" onPress={close} />
        <Button
          title={install ? "Install" : "Turn On"}
          kind="primary"
          disabled={changed}
          onPress={() => {
            if (confirm(name, hash)) onClosed();
          }}
        />
      </DialogActions>
    </Sheet>
  );
}

const LINE = { flex: 1 } as const;
const ICON = { width: 18, height: 18 } as const;
const TITLE_ICON = { width: 28, height: 28 } as const;
