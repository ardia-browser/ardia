import { t, tp } from "../../../lib/i18n";
import { useEffect, useMemo, useRef } from "react";
import { Animated, View } from "react-native";
import { allArcHolders, restoreArcFolders } from "../../../state/bookmarks/bookmarkGroups";
import { useBookmarks } from "../../../state/bookmarks/hooks";
import { useProfileOrder, useProfileRecords } from "../../../state/profiles/hooks";
import type { ImportCounts } from "../../../state/import/apply";
import { backTo, closeImport, openFoundExtensions, type ImportFlow } from "../../../state/import/flow";
import { takeOfferedEngine } from "../../../state/import/searchEngine";
import { useOnboarding } from "../../../state/onboarding/onboarding";
import { Button, space, Symbol, Text, useTheme } from "../../ui";
import { APP, kindTitle } from "../model";
import { Spacer, Title } from "../Parts";
import { ExtensionListingView } from "./ExtensionListing";
import { importLayout, importMotion, importType } from "../tokens";

function summaryOf(counts: ImportCounts) {
  return [
    counts.bookmarks && tp("{count} bookmark", "{count} bookmarks", counts.bookmarks),
    counts.history && tp("{count} history item", "{count} history items", counts.history),
    counts.passwords && tp("{count} password", "{count} passwords", counts.passwords),
    counts.cookies && tp("{count} cookie", "{count} cookies", counts.cookies),
    counts.addresses && tp("{count} address", "{count} addresses", counts.addresses),
    counts.cards && tp("{count} card", "{count} cards", counts.cards),
    counts.tabs && tp("{count} tab", "{count} tabs", counts.tabs),
    counts.rules && tp("{count} Air Traffic Control rule", "{count} Air Traffic Control rules", counts.rules),
    counts.archived && tp("{count} archived tab", "{count} archived tabs", counts.archived),
    counts.settings && tp("{count} setting", "{count} settings", counts.settings),
  ].filter(Boolean) as string[];
}

function ExtensionList({ flow }: { flow: ImportFlow }) {
  const { source, step } = flow;
  const onboarding = useOnboarding((s) => s.windowId !== null);
  if (step.name !== "done") return null;
  const { extensions } = step;
  if (extensions.listing) return <ExtensionListingView listing={extensions.listing} sourceName={source?.name ?? t("Your browser")} />;
  if (!extensions.list.length) return null;
  const centered = { textAlign: "center" } as const;
  return (
    <View style={{ alignSelf: "stretch", marginTop: space.xl, gap: space.m }}>
      <Text size="small" tone="textSecondary" style={centered}>
        {t("{browser} has {extensions} from the Chrome Web Store. Add the ones you want there:", { browser: source?.name ?? t("Your browser"), extensions: tp("{count} extension", "{count} extensions", extensions.list.length) })}
      </Text>
      <Text size="small" style={centered} numberOfLines={3}>
        {extensions.list.map((e) => e.name).join(", ")}
      </Text>
      {extensions.opened ? (
        <Text size="small" tone="textSecondary" style={centered}>
          {tp("Its page is open in your sidebar{when}. Click Add to {app} on each one you want.", "Their pages are open in your sidebar{when}. Click Add to {app} on each one you want.", extensions.list.length, { when: onboarding ? t(", ready when you finish setting up") : "", app: APP })}
        </Text>
      ) : (
        <View style={{ alignItems: "center" }}>
          <Button
            title={tp("Open in Chrome Web Store", "Open {count} in Chrome Web Store", extensions.list.length)}
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
  const from = source?.name ?? t("Your other browser");
  const line = offered ? t("{from} searches with {name}. {app} kept the search engine you chose.", { from, name, app: APP }) : t("Search uses {name} now, as in {from}. You can change it in Settings › Profiles.", { from, name });
  return (
    <View style={{ alignItems: failed ? "flex-start" : "center", gap: space.m, marginTop: failed ? space.s : 0 }}>
      <Text size="small" tone="textSecondary" style={failed ? undefined : { textAlign: "center" }}>
        {line}
      </Text>
      {offered && <Button title={t("Use {name} for Search", { name })} onPress={takeOfferedEngine} />}
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
      title={t("Restore Arc Folders as Groups")}
      onPress={() => {
        for (const id of arcHolders) restoreArcFolders(id, null);
      }}
    />
  );
}

export function DoneBody({ flow }: { flow: ImportFlow }) {
  const { step } = flow;
  if (step.name !== "done") return null;
  const { counts, failures, notes } = step;
  const summary = summaryOf(counts);
  if (failures.length)
    return (
      <>
        <Title title={summary.length ? t("Partially imported") : t("Import failed")} subtitle={t("Only some of your data imported. Please try again!")} />
        <Text weight="semibold" style={{ marginBottom: space.s }}>
          {t("Some import steps failed:")}
        </Text>
        {failures.map((f) => (
          <Text key={f.kind} tone="textSecondary" style={{ marginBottom: space.xs }}>
            {f.profiles.length ? t("{kind} import failed for profiles {profiles}", { kind: kindTitle(f.kind), profiles: f.profiles.join(t(", ")) }) : t("{kind} import failed", { kind: kindTitle(f.kind) })}
          </Text>
        ))}
        {summary.length > 0 && <Text size="small" tone="textSecondary" style={{ marginTop: space.l }}>{t("Imported {summary}.", { summary: summary.join(t(", ")) })}</Text>}
        <SearchEngineLine flow={flow} failed />
        <LeftBehind notes={notes} failed />
        <ExtensionList flow={flow} />
        <Text size="small" tone="textTertiary" style={{ marginTop: space.l }}>
          {t("You can retry the import later from the app menu.")}
        </Text>
      </>
    );
  return (
    <View style={{ alignItems: "center", marginTop: importLayout.doneTop, gap: space.l }}>
      <SuccessMark />
      <Text weight="semibold" style={importType.done}>
        {t("You're all set")}
      </Text>
      <Text tone="textSecondary" style={{ textAlign: "center" }}>
        {summary.length ? t("Imported {summary}.", { summary: summary.join(t(", ")) }) : "There was nothing new to import."}
      </Text>
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
      {failed && <Button title={t("Try Again")} onPress={() => backTo("choose")} />}
      <Button title={failed ? t("Continue") : t("Finish importing")} kind="primary" onPress={closeImport} />
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
