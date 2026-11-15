import { currentEngineProfile } from "../../state/browser/current";
import { clearBrowsingData, type BrowsingDataType } from "../../state/profiles/profileData";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { pruneEngineFavicons } from "../../state/favicons/favicons";
import { isIncognitoProfile } from "../../state/browser/model";
import { useProfileName, useProfileOrder } from "../../state/profiles/hooks";
import { noteBrowsingDataCleared } from "../../state/telemetry/historyRemovalCounts";
import { Box, Button, Checkbox, Dialog, DialogActions, DialogTitle, Group, PopUp, Row, space, Text } from "../ui";
import { clearDataDialog } from "./tokens";

const RANGES = [
  { value: "hour", title: "Last hour", ms: 3_600_000 },
  { value: "day", title: "Last 24 hours", ms: 86_400_000 },
  { value: "week", title: "Last 7 days", ms: 7 * 86_400_000 },
  { value: "month", title: "Last 4 weeks", ms: 28 * 86_400_000 },
  { value: "all", title: "All time", ms: Infinity },
] as const;
type Range = (typeof RANGES)[number]["value"];

export function ClearDataDialog({ profileId, onClose }: { profileId: string; onClose: () => void }) {
  const profileName = useProfileName(profileId);
  const multipleProfiles = useProfileOrder((o) => o.length > 1);
  const [range, setRange] = useState<Range>("hour");
  const [history, setHistory] = useState(true);
  const [siteData, setSiteData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef(false);
  const dismiss = () => {
    if (!pending.current) onClose();
  };

  const clear = async () => {
    if (pending.current || (!history && !siteData)) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    const ms = RANGES.find((r) => r.value === range)!.ms;
    const since = ms === Infinity ? undefined : Date.now() - ms;
    const profile = currentEngineProfile(profileId);
    const types: BrowsingDataType[] = [...(history ? ["history" as const] : []), ...(siteData ? ["siteData" as const, "cache" as const] : [])];
    let cleared = false;
    try {
      if (!isIncognitoProfile(profileId)) {
        await clearBrowsingData(profile, types, since);
        if (history) pruneEngineFavicons(profile);
        noteBrowsingDataCleared(true);
      }
      cleared = true;
    } catch {
      noteBrowsingDataCleared(false);
      setError(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
    if (cleared) onClose();
  };

  return (
    <Dialog width="m" onDismiss={busy ? undefined : dismiss}>
      <DialogTitle subtitle={multipleProfiles ? `From your ${profileName} profile` : undefined}>Clear Browsing Data</DialogTitle>
      <Box row gap="ml" style={RANGE_ROW}>
        <Text>Time range</Text>
        <PopUp value={range} options={RANGES.map(({ value, title }) => ({ value, title }))} onChange={setRange} minWidth={clearDataDialog.rangeMinWidth} disabled={busy} />
      </Box>
      <View style={OPTIONS}>
        <Group>
          <Option value={history} onChange={setHistory} disabled={busy} title="Browsing history" subtitle="Clears the pages you visited from History and the command bar." />
          <Option value={siteData} onChange={setSiteData} disabled={busy} title="Cookies, site data and cached files" subtitle="Signs you out of most sites." />
        </Group>
      </View>
      {error && <Text tone="destructive">Some browsing data could not be cleared. Please try again.</Text>}
      <DialogActions>
        <Button title="Cancel" disabled={busy} onPress={dismiss} />
        <Button title={error ? "Retry" : "Clear Data"} kind="primary" disabled={busy || (!history && !siteData)} onPress={() => void clear()} />
      </DialogActions>
    </Dialog>
  );
}

const RANGE_ROW = { alignItems: "center", marginTop: space.xl } as const;
const OPTIONS = { marginTop: space.xl } as const;

function Option({ value, onChange, disabled, title, subtitle }: { value: boolean; onChange: (v: boolean) => void; disabled: boolean; title: string; subtitle: string }) {
  return (
    <Pressable disabled={disabled} onPress={() => onChange(!value)}>
      <Row icon={<Checkbox value={value} onChange={onChange} disabled={disabled} />} title={title} description={subtitle} />
    </Pressable>
  );
}
