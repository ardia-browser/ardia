import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition, useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PasteAction } from "../sync/SyncPage";
import { openFromSettings,
  addList,
  applyMyFilters,
  removeList,
  resetLists,
  setListEnabled,
  trustSite,
  updateLists,
  updateListsFromButton,
  useBlocking,
  type FilterListInfo,
} from "../../state/settings/actions";
import { popSettings, pushSettings } from "../../state/settings/nav";
import {
  formatNumber,
  listFacts,
  listIsBusy,
  listsStatus,
  listStatus,
  listsText,
  myFiltersCount,
  myFiltersSummary,
  resetMessage,
  rulesText,
  listUpdatedAt,
  filterListAddress,
  FILTER_LIST_ADDRESS,
} from "../../state/settings/settingsRules";
import { ConfirmDialog, duration, font, ink, screenReaderActions, Sheet, usePresence, settingsLayout, settingsTint, space, Symbol, Toggle, useTheme, type Confirmation, useWarningInk } from "../ui";
import { copy } from "../../lib/platformCopy";

const FILTER_SYNTAX_URL = "https://github.com/gorhill/uBlock/wiki/Static-filter-syntax";
import { BarButton, ButtonRow, CrossfadeText, Divider, EmptyState, Group, IconTile, NavRow, SettingsPage, ToggleRow, ValueRow } from "./SettingsKit";

export function FilterListsPage() {
  const theme = useTheme();
  const state = useBlocking((s) => s.state);
  const busy = useBlocking((s) => s.busy);
  const [adding, setAdding] = useState(false);
  const addSheet = usePresence(adding);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const now = Date.now();
  const lists = state?.lists ?? [];
  const groups = useMemo(() => {
    const byGroup = new Map<string, FilterListInfo[]>();
    for (const list of lists) byGroup.set(list.group, [...(byGroup.get(list.group) ?? []), list]);
    return [...byGroup.entries()];
  }, [lists]);
  const enabled = lists.filter((list) => list.isEnabled);
  const updating = busy || Boolean(state?.isUpdating);
  return (
    <SettingsPage
      title="Filter Lists"
      onBack={popSettings}
      onRefresh={updateLists}
      heroTitle
      overlay={addSheet.mounted ? <AddListSheet open={adding} onClose={() => setAdding(false)} onHidden={addSheet.hidden} /> : null}
    >
      <View style={styles.hero}>
        <IconTile icon="shieldLefthalf" tint={settingsTint.ads} side={settingsLayout.heroTile} />
        <Text style={[font.title3, styles.bold, { color: theme.label }]}>Filter Lists</Text>
        <Text style={[font.subheadline, { color: theme.secondaryLabel }]}>{`${listsText(enabled.length)} · ${rulesText(state?.enabledRuleCount ?? 0)}`}</Text>
        <CrossfadeText
          testID="listsStatus"
          text={listsStatus(updating, Boolean(state?.isOffline), state?.lastUpdated ?? null, now)}
          style={[font.footnote, { color: state?.isOffline ? theme.destructive : theme.secondaryLabel }]}
        />
      </View>
      <Group footer="Checked weekly.">
        <ButtonRow title={updating ? "Updating Lists…" : "Update Now"} enabled={!updating} busy={updating} onPress={() => void updateListsFromButton()} />
      </Group>
      {groups.map(([group, items]) => (
        <Group key={group} header={group}>
          {items.map((list, index) => (
            <ListRow key={list.id} list={list} now={now} divider={index < items.length - 1} />
          ))}
        </Group>
      ))}
      <Group>
        <ButtonRow title="Add a List…" divider onPress={() => setAdding(true)} />
        <NavRow title="My Filters" value={myFiltersCount(state?.myFiltersRuleCount ?? 0)} onPress={() => pushSettings({ page: "myFilters" })} />
      </Group>
      <Group>
        <ButtonRow
          title="Restore Defaults…"
          destructive
          onPress={() =>
            setConfirmation({
              title: "Restore Default Filter Lists?",
              message: resetMessage(lists.filter((list) => list.isCustom).length),
              action: "Restore Defaults",
              run: resetLists,
            })
          }
        />
      </Group>
      {confirmation ? <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} /> : null}
    </SettingsPage>
  );
}

function ListRow({ list, now, divider }: { list: FilterListInfo; now: number; divider: boolean }) {
  const theme = useTheme();
  const warningInk = useWarningInk();
  const facts = listFacts(list, now);
  return (
    <View>
      <View style={styles.listRow}>
        <Pressable accessibilityRole="button" accessibilityHint="Shows the list’s details" onPress={() => pushSettings({ page: "filterList", id: list.id })} style={styles.fill}>
          <Text style={[font.body, { color: theme.label }]} numberOfLines={2}>
            {list.title}
          </Text>
          <CrossfadeText testID="listFacts" text={facts.text} style={[font.footnote, { color: facts.isWarning ? warningInk : theme.secondaryLabel }]} />
        </Pressable>
        {listIsBusy(list) ? <ActivityIndicator testID="listBusy" size="small" color={theme.secondaryLabel} /> : null}
        <Toggle label={list.title} value={list.isEnabled} onChange={(on) => setListEnabled(list.id, on)} />
      </View>
      {divider ? <Divider /> : null}
    </View>
  );
}

export function FilterListDetailPage({ id }: { id: string }) {
  const theme = useTheme();
  const list = useBlocking((s) => s.state?.lists.find((item) => item.id === id) ?? null);
  const updating = useBlocking((s) => s.busy || Boolean(s.state?.isUpdating));
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  if (!list)
    return (
      <SettingsPage title="Filter List" onBack={popSettings}>
        <EmptyState title="List Removed" message="" icon="listBulletFill" />
      </SettingsPage>
    );
  return (
    <SettingsPage title={list.title} onBack={popSettings}>
      <Group footer={list.isDefault ? "On by default in uBlock Origin." : null}>
        <ToggleRow title="Use This List" value={list.isEnabled} onChange={(on) => setListEnabled(list.id, on)} />
      </Group>
      {list.state === "failed" ? (
        <Group>
          <View testID="listFailure" style={styles.failure}>
            <Symbol name="exclamationmarkTriangle" size={22} color={theme.destructive} />
            <Text style={[font.body, styles.fill, { color: theme.label }]}>{list.failure ?? "This list couldn’t be updated."}</Text>
          </View>
          <Divider />
          <ButtonRow title="Try Again" enabled={!updating} onPress={() => void updateLists()} />
        </Group>
      ) : null}
      <Group footer={list.skippedCount > 0 ? copy().filterRulesUnsupported : null}>
        <ValueRow title="Status" value={listStatus(list)} divider />
        <ValueRow title="Last Updated" value={list.updatedAt ? listUpdatedAt(list.updatedAt) : "Never"} divider />
        <ValueRow title="Rules" value={formatNumber(list.ruleCount)} divider />
        <ValueRow title="Skipped" value={formatNumber(list.skippedCount)} />
      </Group>
      {list.sourceUrl || list.supportUrl ? (
        <Group header="Source">
          {list.sourceUrl ? <LinkRow text={list.sourceUrl} small divider={Boolean(list.supportUrl)} onPress={() => openFromSettings(list.sourceUrl!)} /> : null}
          {list.supportUrl ? <LinkRow text="Visit the List’s Website" onPress={() => openFromSettings(list.supportUrl!)} /> : null}
        </Group>
      ) : null}
      {list.isCustom ? (
        <Group>
          <ButtonRow
            title="Remove List…"
            destructive
            onPress={() =>
              setConfirmation({
                title: "Remove This List?",
                message: "You can add it again later.",
                action: "Remove List",
                run: () => {
                  removeList(list.id);
                  popSettings();
                },
              })
            }
          />
        </Group>
      ) : null}
      {confirmation ? <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} /> : null}
    </SettingsPage>
  );
}

function LinkRow({ text, small = false, divider = false, onPress }: { text: string; small?: boolean; divider?: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <View>
      <Pressable
        accessibilityRole="link"
        accessibilityHint="Opens the link in a new tab"
        onPress={onPress}
        style={({ pressed }) => [styles.linkRow, pressed ? { backgroundColor: theme.rowHighlight } : null]}
      >
        <Text style={[small ? font.subheadline : font.body, { color: theme.formAccent }]} numberOfLines={2} ellipsizeMode="middle">
          {text}
        </Text>
      </Pressable>
      {divider ? <Divider /> : null}
    </View>
  );
}

function AddListSheet({ open, onClose, onHidden }: { open: boolean; onClose: () => void; onHidden: () => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [address, setAddress] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addingNow = useRef(false);
  const keyboard = useAnimatedKeyboard({ isStatusBarTranslucentAndroid: true, isNavigationBarTranslucentAndroid: true });
  const lift = useAnimatedStyle(() => ({ height: Math.max(keyboard.height.value - insets.bottom, 0) }));
  const check = filterListAddress(address);
  const url = "url" in check ? check.url : null;
  const close = () => {
    if (!adding) onClose();
  };
  const add = async () => {
    if (!url || addingNow.current) return;
    addingNow.current = true;
    setAdding(true);
    const refusal = await addList(url);
    addingNow.current = false;
    setAdding(false);
    if (refusal) setFailure(refusal);
    else onClose();
  };
  useEffect(() => {
    if (!open) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => back.remove();
  });
  const footer = failure
    ? { text: failure, ink: theme.destructive }
    : "message" in check && address
      ? { text: check.message, ink: theme.secondaryLabel }
      : { text: FILTER_LIST_ADDRESS.footer, ink: theme.secondaryLabel };
  return (
    <Sheet open={open} onDismiss={close} onHidden={onHidden}>
      <View style={styles.sheetBar}>
        <View style={styles.sheetSide}>
          <BarButton title="Cancel" onPress={close} />
        </View>
        <Text accessibilityRole="header" style={[font.body, styles.bold, styles.sheetTitle, { color: theme.label }]} numberOfLines={1}>
          Add a List
        </Text>
        <View style={[styles.sheetSide, styles.sheetEnd]}>
          {adding ? <ActivityIndicator testID="addingList" color={theme.secondaryLabel} /> : <BarButton title="Add" emphasized enabled={url !== null} onPress={() => void add()} />}
        </View>
      </View>
      <View style={styles.sheetBody}>
        <Text style={[font.footnote, styles.bold, styles.sheetLabel, { color: theme.secondaryLabel }]}>List Address</Text>
        <View style={[styles.fieldSurface, { backgroundColor: theme.groupFill }]}>
          <TextInput
            accessibilityLabel="List Address"
            autoFocus
            value={address}
            onChangeText={(value) => {
              setAddress(value);
              setFailure(null);
            }}
            onSubmitEditing={() => void add()}
            submitBehavior="submit"
            returnKeyType="done"
            placeholder="https://example.com/filters.txt"
            placeholderTextColor={theme.foregroundTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={[font.body, styles.sheetField, { color: theme.label }]}
          />
        </View>
        <CrossfadeText testID="addListFooter" text={footer.text} style={[font.footnote, styles.sheetLabel, { color: footer.ink }]} />
        {address === "" ? (
          <Animated.View entering={FadeIn.duration(duration.crossfade)} exiting={FadeOut.duration(duration.crossfade)} style={styles.paste}>
            <PasteAction onText={(text) => setAddress(text.trim())} />
          </Animated.View>
        ) : null}
      </View>
      <Animated.View style={lift} />
    </Sheet>
  );
}

export function MyFiltersPage() {
  const theme = useTheme();
  const state = useBlocking((s) => s.state);
  const saved = state?.myFilters ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? saved;
  const changed = draft !== null && draft !== saved;
  const [applying, setApplying] = useState(false);
  const applyingNow = useRef(false);
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard({ isStatusBarTranslucentAndroid: true, isNavigationBarTranslucentAndroid: true });
  const lift = useAnimatedStyle(() => ({ height: Math.max(keyboard.height.value - insets.bottom, 0) }));
  const large = useWindowDimensions().fontScale >= settingsLayout.accessibilityFontScale;
  const apply = async () => {
    if (!changed || applyingNow.current) return;
    applyingNow.current = true;
    setApplying(true);
    await applyMyFilters(text);
    applyingNow.current = false;
    setApplying(false);
    Keyboard.dismiss();
    setDraft(null);
  };
  useEffect(() => {
    if (!changed) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => back.remove();
  }, [changed]);
  return (
    <SettingsPage
      title="My Filters"
      onBack={changed ? undefined : popSettings}
      scroll={false}
      leading={changed ? <BarButton title="Revert" onPress={() => setDraft(null)} /> : null}
      trailing={applying ? <ActivityIndicator testID="applyingFilters" color={theme.secondaryLabel} style={styles.barSpinner} /> : <BarButton title="Apply" emphasized enabled={changed} onPress={() => void apply()} />}
    >
      <View style={[styles.editor, { backgroundColor: theme.groupFill }]}>
        <TextInput
          testID="myFiltersField"
          accessibilityLabel="My Filters"
          multiline
          scrollEnabled
          value={text}
          onChangeText={setDraft}
          placeholder={"||ads.example.com^\nexample.com##.newsletter-popup"}
          placeholderTextColor={theme.foregroundTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          style={[font.subheadline, styles.editorText, { color: theme.label }]}
        />
      </View>
      <View style={styles.footer}>
        <CrossfadeText
          text={myFiltersSummary(state?.myFiltersRuleCount ?? 0, state?.myFiltersSkippedCount ?? 0, changed)}
          style={[font.footnote, styles.bold, { color: changed ? theme.formAccent : theme.secondaryLabel }]}
        />
        {large ? null : <Text style={[font.footnote, { color: theme.secondaryLabel }]}>||site.com^ blocks a site. site.com##.ad hides part of a page. Lines that start with ! are notes.</Text>}
        <Pressable accessibilityRole="link" onPress={() => openFromSettings(FILTER_SYNTAX_URL)} style={styles.syntax}>
          <Text style={[font.footnote, styles.bold, { color: theme.formAccent }]}>Filter Syntax</Text>
        </Pressable>
      </View>
      <Animated.View style={lift} />
    </SettingsPage>
  );
}

export function TrustedSitesPage() {
  const exempt = useBlocking((s) => s.state?.exemptHosts);
  const hosts = useMemo(() => [...(exempt ?? [])].sort(), [exempt]);
  const [editing, setEditing] = useState(false);
  const editingShown = editing && hosts.length > 0;
  return (
    <SettingsPage
      title="Trusted Sites"
      onBack={popSettings}
      trailing={hosts.length ? <BarButton title={editingShown ? "Done" : "Edit"} emphasized={editingShown} onPress={() => setEditing(!editingShown)} /> : null}
    >
      {hosts.length === 0 ? (
        <EmptyState title="No Trusted Sites" message="Sites you allow from the page menu show up here." icon="checkmarkShield" />
      ) : (
        <Group>
          {hosts.map((host, index) => (
            <TrustedSiteRow key={host} host={host} editing={editingShown} divider={index < hosts.length - 1} />
          ))}
        </Group>
      )}
    </SettingsPage>
  );
}

function TrustedSiteRow({ host, editing, divider }: { host: string; editing: boolean; divider: boolean }) {
  const theme = useTheme();
  const removeLabel = `Remove ${host}`;
  const remove = () => trustSite(host, false);
  return (
    <Animated.View exiting={FadeOut.duration(duration.crossfade)} layout={LinearTransition.duration(duration.crossfade)}>
      <View
        testID={`trusted:${host}`}
        accessible
        accessibilityLabel={host}
        {...screenReaderActions([{ name: "remove", label: removeLabel, run: remove }])}
        style={styles.listRow}
      >
        {editing ? (
          <Animated.View entering={FadeIn.duration(duration.crossfade)} exiting={FadeOut.duration(duration.crossfade)}>
            <Pressable accessibilityRole="button" accessibilityLabel={removeLabel} onPress={remove} style={[styles.removeDot, { backgroundColor: theme.destructive }]}>
              <Symbol name="minus" size={14} color={ink.white} />
            </Pressable>
          </Animated.View>
        ) : null}
        <Animated.View layout={LinearTransition.duration(duration.crossfade)} style={styles.trustedLabel}>
          <Symbol name="globe" size={22} color={theme.secondaryLabel} />
          <Text style={[font.body, styles.fill, { color: theme.label }]}>{host}</Text>
        </Animated.View>
      </View>
      {divider ? <Divider inset={settingsLayout.rowInset + TRUSTED_GLOBE + settingsLayout.labelGap} /> : null}
    </Animated.View>
  );
}

const TRUSTED_GLOBE = 22;

const styles = StyleSheet.create({
  syntax: { alignSelf: "flex-start", paddingVertical: space.xs },
  hero: { alignItems: "center", gap: space.xs, paddingHorizontal: space.l },
  bold: { fontWeight: "600" },
  fill: { flex: 1 },
  listRow: { flexDirection: "row", alignItems: "center", gap: space.m, minHeight: settingsLayout.rowMinHeight, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.s },
  failure: { flexDirection: "row", alignItems: "center", gap: settingsLayout.labelGap, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.s, minHeight: settingsLayout.rowMinHeight },
  linkRow: { minHeight: settingsLayout.rowMinHeight, justifyContent: "center", paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.s },
  sheetBar: { flexDirection: "row", alignItems: "center", minHeight: settingsLayout.topBar, paddingHorizontal: space.xs },
  sheetSide: { flex: 1, flexDirection: "row" },
  sheetEnd: { justifyContent: "flex-end", paddingRight: space.s },
  sheetTitle: { textAlign: "center" },
  sheetBody: { paddingVertical: space.l, gap: space.s },
  sheetLabel: { paddingHorizontal: settingsLayout.rowInset + space.l },
  fieldSurface: { marginHorizontal: space.l, borderRadius: settingsLayout.groupRadius, paddingHorizontal: settingsLayout.rowInset, minHeight: settingsLayout.rowMinHeight, justifyContent: "center" },
  sheetField: { minHeight: settingsLayout.rowMinHeight },
  paste: { alignItems: "center", paddingTop: space.s },
  editor: { flex: 1, marginHorizontal: space.l, marginTop: space.xs, borderRadius: settingsLayout.groupRadius, padding: space.l },
  barSpinner: { marginRight: space.s },
  editorText: { flex: 1, textAlignVertical: "top", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  footer: { paddingHorizontal: space.l + settingsLayout.rowInset, gap: space.xs },
  removeDot: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  trustedLabel: { flex: 1, flexDirection: "row", alignItems: "center", gap: settingsLayout.labelGap },
});
