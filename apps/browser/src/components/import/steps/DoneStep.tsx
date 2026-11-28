import { useEffect, useMemo, useRef } from "react";
import { Animated, ScrollView, View } from "react-native";
import { allArcHolders, restoreArcFolders } from "../../../state/bookmarks/bookmarkGroups";
import { useBookmarks } from "../../../state/bookmarks/hooks";
import { plural } from "../../../state/browser/model";
import { useProfileOrder, useProfileRecords } from "../../../state/profiles/hooks";
import type { BrowserSource, ImportCounts } from "../../../state/import/apply";
import { backTo, closeImport, openFoundExtensions, type ImportFlow, type SourceTally } from "../../../state/import/flow";
import { spokenList } from "../../../lib/lists";
import { takeOfferedEngine } from "../../../state/import/searchEngine";
import { useOnboarding } from "../../../state/onboarding/onboarding";
import { Button, space, Symbol, Text, useTheme } from "../../ui";
import { APP, kindTitle } from "../model";
import { Spacer, Title } from "../Parts";
import { BrowserIcon } from "../Rows";
import { ExtensionListingView } from "./ExtensionListing";
import { importLayout, importMotion, importType } from "../tokens";

const COUNTED: { key: keyof ImportCounts; one: string; many?: string; title: string }[] = [
  { key: "bookmarks", one: "bookmark", title: "Bookmarks" },
  { key: "history", one: "history item", title: "History" },
  { key: "passwords", one: "password", title: "Passwords" },
  { key: "cookies", one: "cookie", title: "Cookies" },
  { key: "addresses", one: "address", many: "addresses", title: "Addresses" },
  { key: "cards", one: "card", title: "Cards" },
  { key: "tabs", one: "tab", title: "Tabs" },
  { key: "rules", one: "Air Traffic Control rule", title: "Air Traffic Control rules" },
  { key: "archived", one: "archived tab", title: "Archived tabs" },
  { key: "settings", one: "setting", title: "Settings" },
];

function summaryOf(counts: ImportCounts) {
  return COUNTED.filter((c) => counts[c.key]).map((c) => (c.many ? `${counts[c.key]} ${counts[c.key] === 1 ? c.one : c.many}` : plural(counts[c.key], c.one)));
}

function sourceNameOf({ source, step }: ImportFlow) {
  if (step.name === "done" && step.sources?.length) return spokenList(step.sources.map((s) => s.name));
  return source?.name ?? "Your browser";
}

function SourceTable({ sources, counts, browsers }: { sources: SourceTally[]; counts: ImportCounts; browsers: BrowserSource[] }) {
  const rows = COUNTED.filter((c) => counts[c.key]);
  if (!rows.length) return null;
  const column = { width: importLayout.tallyColumn, alignItems: "center" } as const;
  const label = { width: importLayout.tallyLabel } as const;
  return (
    <ScrollView horizontal style={{ alignSelf: "stretch", marginTop: space.l }} contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}>
      <View style={{ gap: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.m, marginBottom: space.xs }}>
          <View style={label} />
          {sources.map((s) => (
            <View key={s.id} style={{ ...column, gap: space.xs }}>
              <BrowserIcon iconPath={browsers.find((b) => b.id === s.id)?.iconPath} size={importLayout.tallyIcon} />
              <Text size="small" weight="semibold" style={{ textAlign: "center" }}>
                {s.name}
              </Text>
            </View>
          ))}
        </View>
        {rows.map((c) => (
          <View key={c.key} style={{ flexDirection: "row", alignItems: "center", gap: space.m }}>
            <Text size="small" tone="textSecondary" style={label}>
              {c.title}
            </Text>
            {sources.map((s) => (
              <View key={s.id} style={column}>
                <Text size="small" tone={s.counts[c.key] ? "textPrimary" : "textTertiary"}>
                  {s.counts[c.key] ? s.counts[c.key].toLocaleString("en-US") : "–"}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function ExtensionList({ flow }: { flow: ImportFlow }) {
  const { step } = flow;
  const onboarding = useOnboarding((s) => s.windowId !== null);
  if (step.name !== "done") return null;
  const { extensions } = step;
  const from = sourceNameOf(flow);
  const several = !!step.sources && step.sources.length > 1;
  if (extensions.listing) return <ExtensionListingView listing={extensions.listing} sourceName={from} several={several} />;
  if (!extensions.list.length) return null;
  const centered = { textAlign: "center" } as const;
  return (
    <View style={{ alignSelf: "stretch", marginTop: space.xl, gap: space.m }}>
      <Text size="small" tone="textSecondary" style={centered}>
        {`${from} ${several ? "have" : "has"} ${plural(extensions.list.length, "extension")} from the Chrome Web Store. Add the ones you want there:`}
      </Text>
      <Text size="small" style={centered} numberOfLines={3}>
        {extensions.list.map((e) => e.name).join(", ")}
      </Text>
      {extensions.opened ? (
        <Text size="small" tone="textSecondary" style={centered}>
          {`${extensions.list.length === 1 ? "Its page is" : "Their pages are"} open in your sidebar${onboarding ? ", ready when you finish setting up" : ""}. Click Add to ${APP} on each one you want.`}
        </Text>
      ) : (
        <View style={{ alignItems: "center" }}>
          <Button
            title={extensions.list.length === 1 ? "Open in Chrome Web Store" : `Open ${extensions.list.length} in Chrome Web Store`}
            onPress={openFoundExtensions}
          />
        </View>
      )}
    </View>
  );
}

function LeftBehind({ notes, failed }: { notes: string[]; failed: boolean }) {
  if (!notes.length) return null;
  return (
    <Text size="caption" tone="textSecondary" style={{ lineHeight: importType.smallLine, marginTop: space.ml, textAlign: failed ? "left" : "center" }}>
      {notes.join(" ")}
    </Text>
  );
}

function SearchEngineLine({ flow, failed }: { flow: ImportFlow; failed: boolean }) {
  const { source, step } = flow;
  if (step.name !== "done" || !step.searchEngine) return null;
  const { name, offered } = step.searchEngine;
  const from = step.engineFrom ?? source?.name ?? "Your other browser";
  const line = offered ? `${from} searches with ${name}. ${APP} kept the search engine you chose.` : `Search uses ${name} now, as in ${from}. You can change it in Settings › Profiles.`;
  return (
    <View style={{ alignItems: failed ? "flex-start" : "center", gap: space.m, marginTop: failed ? space.s : 0 }}>
      <Text size="small" tone="textSecondary" style={failed ? undefined : { textAlign: "center" }}>
        {line}
      </Text>
      {offered && <Button title={`Use ${name} for Search`} onPress={takeOfferedEngine} />}
    </View>
  );
}

function RestoreArcFolders() {
  const bookmarks = useBookmarks((b) => b);
  const profiles = useProfileRecords();
  const profileOrder = useProfileOrder();
  const arcHolders = useMemo(() => allArcHolders({ bookmarks, profiles, profileOrder }), [bookmarks, profiles, profileOrder]);
  if (!arcHolders.length) return null;
  return (
    <Button
      title="Restore Arc Folders as Groups"
      onPress={() => {
        for (const id of arcHolders) restoreArcFolders(id, null);
      }}
    />
  );
}

export function DoneBody({ flow }: { flow: ImportFlow }) {
  const { step } = flow;
  if (step.name !== "done") return null;
  const { counts, failures, notes, sources } = step;
  const summary = summaryOf(counts);
  const table = sources && sources.length > 1 ? sources : null;
  const fromLine = table ? `From ${spokenList(table.map((s) => s.name))}` : null;
  if (failures.length)
    return (
      <>
        <Title title={summary.length ? "Partially imported" : "Import failed"} subtitle={fromLine ? `${fromLine}. Only some of your data imported. Please try again!` : "Only some of your data imported. Please try again!"} />
        <Text weight="semibold" style={{ marginBottom: space.s }}>
          Some import steps failed:
        </Text>
        {failures.map((f) => (
          <Text key={`${f.browser ?? ""}-${f.kind}`} tone="textSecondary" style={{ marginBottom: space.xs }}>
            {`${f.browser ? `${f.browser}: ` : ""}${f.profiles.length ? `${kindTitle(f.kind)} import failed for profiles ${f.profiles.join(", ")}` : `${kindTitle(f.kind)} import failed`}`}
          </Text>
        ))}
        {table ? (
          <SourceTable sources={table} counts={counts} browsers={flow.browsers} />
        ) : (
          summary.length > 0 && <Text size="small" tone="textSecondary" style={{ marginTop: space.l }}>{`Imported ${summary.join(", ")}.`}</Text>
        )}
        <SearchEngineLine flow={flow} failed />
        <LeftBehind notes={notes} failed />
        <ExtensionList flow={flow} />
        <Text size="small" tone="textTertiary" style={{ marginTop: space.l }}>
          You can retry the import later from the app menu.
        </Text>
      </>
    );
  return (
    <View style={{ alignItems: "center", marginTop: importLayout.doneTop, gap: space.l }}>
      <SuccessMark />
      <Text weight="semibold" style={importType.done}>
        You're all set
      </Text>
      {table ? (
        <>
          <Text tone="textSecondary" style={{ textAlign: "center" }}>
            {summary.length ? fromLine : `${fromLine}: there was nothing new to import.`}
          </Text>
          <SourceTable sources={table} counts={counts} browsers={flow.browsers} />
        </>
      ) : (
        <Text tone="textSecondary" style={{ textAlign: "center" }}>
          {summary.length ? `Imported ${summary.join(", ")}.` : "There was nothing new to import."}
        </Text>
      )}
      <SearchEngineLine flow={flow} failed={false} />
      <LeftBehind notes={notes} failed={false} />
      <ExtensionList flow={flow} />
      <RestoreArcFolders />
    </View>
  );
}

export function DoneFooter({ flow }: { flow: ImportFlow }) {
  const failed = flow.step.name === "done" && flow.step.failures.length > 0;
  return (
    <>
      <Spacer />
      {failed && <Button title="Try Again" onPress={() => backTo("choose", flow.turn)} />}
      <Button title={failed ? "Continue" : "Finish importing"} kind="primary" onPress={closeImport} />
    </>
  );
}

function SuccessMark() {
  const theme = useTheme();
  const { success } = importMotion;
  const scale = useRef(new Animated.Value(success.from)).current;
  useEffect(() => {
    Animated.spring(scale, { toValue: 1, ...success.spring, useNativeDriver: true }).start();
  }, []);
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Symbol name="checkmark.circle.fill" size={46} color={theme.success} style={{ width: 60, height: 60 }} />
    </Animated.View>
  );
}
