import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import {
  addFilterList,
  onContentBlockerChange,
  removeFilterList,
  setContentBlockerEnabled,
  type ContentBlockerState,
  type FilterList,
  type FilterListCategory,
} from "../../../state/site/siteSettings";
import { Button, Checkbox, DialogActions, DialogTitle, Sheet, space, Text, TextField } from "../../ui";
import { Group, Row, SectionHeader } from "../Form";
import { setting, type SettingId } from "../settingsIndex";
import { contentBlocker } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { closeSettingsSheet } from "../../../state/settings/sheet";
import { blockerAvailable, filterListAddress, filterListLabel, setFilterList } from "../../../state/site/contentBlocking";
import { noteContentBlockerUnavailable, noteContentBlockerWriteFailure, noteCustomFilterList } from "../../../state/telemetry/usage";
import { UI_LOCALE } from "../../../lib/uiLocale";

export const CATEGORIES: { id: FilterListCategory; section: string; anchor?: SettingId }[] = [
  { id: "ads", section: "Ad blockers", anchor: "privacy.blockAds" },
  { id: "trackers", section: "Trackers", anchor: "privacy.blockTrackers" },
  { id: "cookies", section: "Cookie banners", anchor: "privacy.blockCookieBanners" },
  { id: "annoyances", section: "Annoyances" },
  { id: "security", section: "Malware and scams" },
  { id: "regional", section: "Regional blockers" },
];

const filtersText = (n: number) => `${n.toLocaleString(UI_LOCALE)} ${n === 1 ? "filter" : "filters"}`;

const customListText = (l: FilterList) => (l.failed ? "Couldn't download. uBlock Origin tries again at the next update." : l.filters ? filtersText(l.filters) : "Downloading…");

const LIST_DOWNLOAD_RECHECK_MS = 10_000;

const UNAVAILABLE_RETRY_MS = 3000;

export function useContentBlocker({ countOutages = false } = {}) {
  const [state, reload] = useResource(contentBlocker);
  const refresh = () => void reload();
  useEffect(() => {
    const sub = onContentBlockerChange(refresh);
    return () => sub.remove();
  }, []);
  const unavailable = !!state && !blockerAvailable(state);
  useEffect(() => {
    if (!unavailable) return;
    if (countOutages) noteContentBlockerUnavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const retry = () => {
      timer = setTimeout(() => void reload().finally(() => !stopped && retry()), UNAVAILABLE_RETRY_MS);
    };
    retry();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [unavailable]);
  return [blockerAvailable(state ?? null) ? state! : null, refresh, unavailable] as const;
}

export async function writeBlocker(write: () => Promise<unknown>, refresh: () => void) {
  try {
    await write();
  } catch {
    noteContentBlockerWriteFailure();
  } finally {
    refresh();
  }
}


const LISTS = { maxHeight: 420, marginTop: space.m } as const;

export function FilterListsSheet() {
  const [blocker, refresh] = useContentBlocker();
  const toggle = async (l: FilterList, on: boolean) => {
    if (!blocker) return;
    await writeBlocker(() => setFilterList(blocker, l.id, on), refresh);
  };
  return (
    <Sheet size="l" onClose={closeSettingsSheet}>
      <DialogTitle subtitle={setting("privacy.filterLists").description}>Advanced Ad Block Settings</DialogTitle>
      <ScrollView style={LISTS}>
        <CustomLists blocker={blocker} refresh={refresh} />
        {CATEGORIES.map((c) => {
          const lists = blocker?.lists.filter((l) => l.category === c.id) ?? [];
          if (!lists.length) return null;
          return (
            <View key={c.id}>
              <SectionHeader title={c.section} />
              <Group>
                {lists.map((l) => (
                  <Row
                    key={l.id}
                    title={<Checkbox value={l.enabled} onChange={(v) => void toggle(l, v)} label={l.title} />}
                    description={l.defaultOn ? `${filtersText(l.filters)} · On by default` : filtersText(l.filters)}
                  />
                ))}
              </Group>
            </View>
          );
        })}
      </ScrollView>
      <DialogActions
        note={
          <Text size="caption" tone="textTertiary">
            {blocker?.version ? `Blocking by uBlock Origin ${blocker.version}, included with Ardia. Its lists update on their own.` : ""}
          </Text>
        }
      >
        <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
      </DialogActions>
    </Sheet>
  );
}

function CustomLists({ blocker, refresh }: { blocker: ContentBlockerState | null; refresh: () => void }) {
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const lists = blocker?.lists.filter((l) => l.category === "custom") ?? [];
  const downloading = lists.some((l) => !l.failed && !l.filters);
  useEffect(() => {
    if (!downloading) return;
    const timer = setTimeout(refresh, LIST_DOWNLOAD_RECHECK_MS);
    return () => clearTimeout(timer);
  }, [downloading, blocker]);
  const address = filterListAddress(typed);
  const add = async () => {
    if (!blocker || !address || adding) return;
    setAdding(true);
    setNote(null);
    try {
      const added = await addFilterList(address);
      const title = filterListLabel(added.id, blocker.lists.find((l) => l.id === added.id)?.title ?? "");
      if (added.failed && added.custom && !added.existed) {
        await removeFilterList(added.id).catch(() => {});
        noteCustomFilterList("addFailed");
        setNote({ text: "Couldn't download a filter list from that address.", error: true });
        return;
      }
      noteCustomFilterList("added");
      if (!blocker.enabled) await setContentBlockerEnabled(true);
      setTyped("");
      if (added.existed) setNote({ text: `${title} is already on.`, error: false });
      else if (!added.custom) setNote({ text: `That's ${title}, one of the lists below. It's on now.`, error: false });
    } catch {
      noteCustomFilterList("addFailed");
      setNote({ text: "uBlock Origin didn't take that list. Check the address and try again.", error: true });
    } finally {
      setAdding(false);
      refresh();
    }
  };
  const remove = (l: FilterList) => {
    noteCustomFilterList("removed");
    void writeBlocker(() => removeFilterList(l.id), refresh);
  };
  const toggle = (l: FilterList, on: boolean) => {
    if (blocker) void writeBlocker(() => setFilterList(blocker, l.id, on), refresh);
  };
  return (
    <View>
      <SectionHeader title="Your lists" description="Filter lists you add by address, in Adblock Plus or uBlock Origin format." />
      <Group>
        {lists.map((l) => (
          <Row
            key={l.id}
            title={<Checkbox value={l.enabled} onChange={(v) => toggle(l, v)} label={filterListLabel(l.id, l.title)} />}
            description={customListText(l)}
          >
            <Button variant="icon" icon="trash" size="m" onPress={() => remove(l)} tooltip="Remove" />
          </Row>
        ))}
        <Row
          title={
            <TextField
              value={typed}
              onChangeText={(t) => {
                setTyped(t);
                setNote(null);
              }}
              placeholder="https://example.com/filters.txt"
              invalid={!!typed.trim() && !address}
              onSubmit={() => void add()}
            />
          }
        >
          <Button title={adding ? "Adding…" : "Add"} disabled={!blocker || !address || adding} onPress={() => void add()} />
        </Row>
      </Group>
      {note && (
        <Text size="caption" tone={note.error ? "destructive" : "textTertiary"} style={NOTE}>
          {note.text}
        </Text>
      )}
    </View>
  );
}

const NOTE = { marginTop: space.s } as const;
