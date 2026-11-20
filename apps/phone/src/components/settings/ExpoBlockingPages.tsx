import { useEffect, useMemo, useRef, useState } from "react";
import { PlatformColor, useWindowDimensions, View } from "react-native";
import { BottomSheet, Button, ConfirmationDialog, ContentUnavailableView, Form, Group, HStack, Image, Label, LabeledContent, List, NavigationLink, NavigationStack, ProgressView, RNHostView, Section, Spacer, Text, TextField, Toggle, Toolbar, ToolbarItem, VStack, ZStack, useNativeState } from "@expo/ui/swift-ui";
import {
  accessibilityHidden,
  backgroundOverlay,
  accessibilityHint,
  autocorrectionDisabled,
  buttonStyle,
  contentTransition,
  disabled,
  environment,
  font,
  foregroundStyle,
  frame,
  interactiveDismissDisabled,
  keyboardType,
  labelsHidden,
  lineLimit,
  listRowBackground,
  navigationBarTitleDisplayMode,
  navigationTitle,
  onSubmit,
  padding,
  presentationDetents,
  presentationDragIndicator,
  refreshable,
  submitLabel,
  textInputAutocapitalization,
  tint,
  truncationMode,
} from "@expo/ui/swift-ui/modifiers";
import { copy } from "../../lib/platformCopy";
import { addList, applyMyFilters, openFromSettings, removeList, resetLists, setListEnabled, trustSite, updateLists, updateListsFromButton, useBlocking, type FilterListInfo } from "../../state/settings/actions";
import { popSettings, pushSettings, settingsRouteKey, type SettingsRoute } from "../../state/settings/nav";
import { FILTER_LIST_ADDRESS, filterListAddress, formatNumber, listFacts, listIsBusy, listsStatus, listStatus, listsText, listUpdatedAt, myFiltersCount, myFiltersSummary, resetMessage, rulesText } from "../../state/settings/settingsRules";
import { PasteAction, SYSTEM_PASTE_SIZE } from "../sync/SyncPage";
import { FilterTextEditor, legibleInk, modifierList, navigationBarBackButtonHidden, settingsChrome, settingsLayout, settingsPage, settingsSwitchStyle } from "../ui";
import { haptics } from "../../state/app/haptics";
import { ExpoHero } from "./ExpoSettingsParts";

const FILL = Number.MAX_SAFE_INTEGER;
const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const BLUE = PlatformColor("systemBlue");

export function ExpoFilterListsPage() {
  const state = useBlocking((s) => s.state);
  const busy = useBlocking((s) => s.busy);
  const [adding, setAdding] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const lists = state?.lists ?? [];
  const groups = useMemo(() => {
    const byGroup = new Map<string, FilterListInfo[]>();
    for (const list of lists) byGroup.set(list.group, [...(byGroup.get(list.group) ?? []), list]);
    return [...byGroup.entries()];
  }, [lists]);
  const enabled = lists.filter((list) => list.isEnabled);
  const updating = busy || Boolean(state?.isUpdating);
  const now = Date.now();
  return (
    <Form modifiers={modifierList(settingsPage("Filter Lists"), tint(BLUE), settingsChrome(), refreshable(async () => void (await updateLists())))}>
      <ExpoHero title="Filter Lists" subtitle={`${listsText(enabled.length)} · ${rulesText(state?.enabledRuleCount ?? 0)}`} systemImage="shield.lefthalf.filled" tint="ads">
        <Text modifiers={modifierList(font({ textStyle: "footnote" }), state?.isOffline ? legibleInk("orange") : foregroundStyle(SECONDARY), contentTransition("opacity"))}>
          {listsStatus(updating, Boolean(state?.isOffline), state?.lastUpdated ?? null, now)}
        </Text>
      </ExpoHero>
      <Section footer={<Text>Checked weekly.</Text>}>
        <Button onPress={() => void updateListsFromButton()} modifiers={[disabled(updating)]}>
          <HStack>
            <Text>{updating ? "Updating Lists…" : "Update Now"}</Text>
            <Spacer />
            {updating ? <ProgressView /> : null}
          </HStack>
        </Button>
      </Section>
      {groups.map(([group, items]) => (
        <Section key={group} title={group}>
          {items.map((list) => (
            <FilterListRow key={list.id} list={list} now={now} />
          ))}
        </Section>
      ))}
      <Section>
        <AddListSheet open={adding} onOpen={() => setAdding(true)} onClose={() => setAdding(false)} />
        <NavigationLink value={settingsRouteKey({ page: "myFilters" })}>
          <LabeledContent label="My Filters">
            <Text>{myFiltersCount(state?.myFiltersRuleCount ?? 0)}</Text>
          </LabeledContent>
        </NavigationLink>
      </Section>
      <Section>
        <ConfirmationDialog title="Restore Default Filter Lists?" isPresented={confirmingReset} onIsPresentedChange={setConfirmingReset} titleVisibility="visible">
          <ConfirmationDialog.Trigger>
            <Button role="destructive" label="Restore Defaults…" onPress={() => setConfirmingReset(true)} />
          </ConfirmationDialog.Trigger>
          <ConfirmationDialog.Actions>
            <Button role="destructive" label="Restore Defaults" onPress={() => void resetLists()} />
          </ConfirmationDialog.Actions>
          <ConfirmationDialog.Message>
            <Text>{resetMessage(lists.filter((list) => list.isCustom).length)}</Text>
          </ConfirmationDialog.Message>
        </ConfirmationDialog>
      </Section>
    </Form>
  );
}

function FilterListRow({ list, now }: { list: FilterListInfo; now: number }) {
  const facts = listFacts(list, now);
  return (
    <HStack spacing={12} modifiers={[padding({ vertical: 2 })]}>
      <Button onPress={() => pushSettings({ page: "filterList", id: list.id })} modifiers={[buttonStyle("plain"), accessibilityHint("Shows the list’s details")]}>
        <VStack alignment="leading" spacing={2} modifiers={[frame({ maxWidth: FILL, alignment: "leading" })]}>
          <Text>{list.title}</Text>
          <Text modifiers={modifierList(font({ textStyle: "subheadline" }), facts.isWarning ? legibleInk("orange") : foregroundStyle(SECONDARY), contentTransition("opacity"))}>{facts.text}</Text>
        </VStack>
      </Button>
      {listIsBusy(list) ? <ProgressView modifiers={[accessibilityHidden(true)]} /> : null}
      <Toggle isOn={list.isEnabled} onIsOnChange={(on) => setListEnabled(list.id, on)} modifiers={modifierList(settingsSwitchStyle(), labelsHidden())}>
        <Text>{list.title}</Text>
      </Toggle>
    </HStack>
  );
}

function AddListSheet({ open, onOpen, onClose }: { open: boolean; onOpen: () => void; onClose: () => void }) {
  const text = useNativeState("");
  const [address, setAddress] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addingNow = useRef(false);
  const check = filterListAddress(address);
  const url = "url" in check ? check.url : null;
  useEffect(() => {
    if (!open) return;
    text.set("");
    setAddress("");
    setFailure(null);
  }, [open]);
  const close = () => {
    if (!addingNow.current) onClose();
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
  const footer = failure ? <Text modifiers={modifierList(legibleInk("red"))}>{failure}</Text> : "message" in check && address ? <Text modifiers={[foregroundStyle(SECONDARY)]}>{check.message}</Text> : <Text>{FILTER_LIST_ADDRESS.footer}</Text>;
  return (
    <BottomSheet anchor={<Button label="Add a List…" onPress={onOpen} />} isPresented={open} onIsPresentedChange={(presented) => (presented ? undefined : close())}>
      <Group modifiers={[presentationDetents(["medium", "large"]), presentationDragIndicator("hidden"), interactiveDismissDisabled(adding)]}>
        <NavigationStack>
          <Toolbar>
            <Form modifiers={[navigationTitle("Add a List"), navigationBarTitleDisplayMode("inline"), tint(BLUE)]}>
              <Section title="List Address" footer={footer}>
                <TextField
                  text={text}
                  placeholder="https://example.com/filters.txt"
                  autoFocus
                  onTextChange={(value) => {
                    setAddress(value);
                    setFailure(null);
                  }}
                  modifiers={[keyboardType("url"), textInputAutocapitalization("never"), autocorrectionDisabled(), submitLabel("done"), onSubmit(() => void add())]}
                />
              </Section>
              {address ? null : (
                <Section modifiers={[listRowBackground("clear")]}>
                  <RNHostView matchContents>
                    <View style={{ alignItems: "center", minHeight: SYSTEM_PASTE_SIZE.height }}>
                      <PasteAction
                        onText={(pasted) => {
                          const trimmed = pasted.trim();
                          text.set(trimmed);
                          setAddress(trimmed);
                        }}
                      />
                    </View>
                  </RNHostView>
                </Section>
              )}
            </Form>
            <Toolbar.Content>
              <ToolbarItem placement="cancellationAction">
                <Button label="Cancel" role="cancel" onPress={close} />
              </ToolbarItem>
              <ToolbarItem placement="confirmationAction">{adding ? <ProgressView /> : <Button label="Add" onPress={() => void add()} modifiers={[disabled(url === null)]} />}</ToolbarItem>
            </Toolbar.Content>
          </Toolbar>
        </NavigationStack>
      </Group>
    </BottomSheet>
  );
}

export function ExpoFilterListPage({ route }: { route: SettingsRoute }) {
  const id = route.page === "filterList" ? route.id : "";
  const list = useBlocking((s) => s.state?.lists.find((item) => item.id === id) ?? null);
  const updating = useBlocking((s) => s.busy || Boolean(s.state?.isUpdating));
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  if (!list) {
    return (
      <Form modifiers={modifierList(navigationTitle("Filter List"), navigationBarTitleDisplayMode("inline"), settingsChrome())}>
        <ContentUnavailableView title="List Removed" systemImage="list.bullet.rectangle" />
      </Form>
    );
  }
  return (
    <Form modifiers={modifierList(navigationTitle(list.title), navigationBarTitleDisplayMode("inline"), tint(BLUE), settingsChrome())}>
      <Section footer={list.isDefault ? <Text>On by default in uBlock Origin.</Text> : undefined}>
        <Toggle isOn={list.isEnabled} onIsOnChange={(on) => setListEnabled(list.id, on)} modifiers={modifierList(settingsSwitchStyle())}>
          <Text>Use This List</Text>
        </Toggle>
      </Section>
      {list.state === "failed" ? (
        <Section>
          <Label title={list.failure ?? "This list couldn’t be updated."} icon={<Image systemName="exclamationmark.triangle.fill" modifiers={modifierList(legibleInk("orange"))} />} />
          <Button label="Try Again" onPress={() => void updateLists()} modifiers={[disabled(updating)]} />
        </Section>
      ) : null}
      <Section footer={list.skippedCount > 0 ? <Text>{copy().filterRulesUnsupported}</Text> : undefined}>
        <LabeledContent label="Status">
          <Text>{listStatus(list)}</Text>
        </LabeledContent>
        <LabeledContent label="Last Updated">
          <Text>{list.updatedAt ? listUpdatedAt(list.updatedAt) : "Never"}</Text>
        </LabeledContent>
        <LabeledContent label="Rules">
          <Text>{formatNumber(list.ruleCount)}</Text>
        </LabeledContent>
        <LabeledContent label="Skipped">
          <Text>{formatNumber(list.skippedCount)}</Text>
        </LabeledContent>
      </Section>
      {list.sourceUrl || list.supportUrl ? (
        <Section title="Source">
          {list.sourceUrl ? (
            <Button onPress={() => openFromSettings(list.sourceUrl!)} modifiers={[accessibilityHint("Opens the link in a new tab")]}>
              <Text modifiers={[font({ textStyle: "subheadline" }), lineLimit(2), truncationMode("middle")]}>{list.sourceUrl}</Text>
            </Button>
          ) : null}
          {list.supportUrl ? <Button label="Visit the List’s Website" onPress={() => openFromSettings(list.supportUrl!)} modifiers={[accessibilityHint("Opens the link in a new tab")]} /> : null}
        </Section>
      ) : null}
      {list.isCustom ? (
        <Section>
          <ConfirmationDialog title="Remove This List?" isPresented={confirmingRemoval} onIsPresentedChange={setConfirmingRemoval} titleVisibility="visible">
            <ConfirmationDialog.Trigger>
              <Button role="destructive" label="Remove List…" onPress={() => setConfirmingRemoval(true)} />
            </ConfirmationDialog.Trigger>
            <ConfirmationDialog.Actions>
              <Button
                role="destructive"
                label="Remove List"
                onPress={() => {
                  removeList(list.id);
                  popSettings();
                }}
              />
            </ConfirmationDialog.Actions>
            <ConfirmationDialog.Message>
              <Text>You can add it again later.</Text>
            </ConfirmationDialog.Message>
          </ConfirmationDialog>
        </Section>
      ) : null}
    </Form>
  );
}

export function ExpoTrustedSitesPage() {
  const exempt = useBlocking((s) => s.state?.exemptHosts);
  const hosts = useMemo(() => [...(exempt ?? [])].sort(), [exempt]);
  const [editing, setEditing] = useState(false);
  const page = [navigationTitle("Trusted Sites"), navigationBarTitleDisplayMode("inline"), tint(BLUE)];
  if (hosts.length === 0) {
    return <ContentUnavailableView title="No Trusted Sites" systemImage="checkmark.shield" description="Sites you allow from the page menu show up here." modifiers={modifierList(...page, frame({ maxWidth: FILL, maxHeight: FILL }), settingsChrome())} />;
  }
  return (
    <Toolbar>
      <List modifiers={modifierList(...page, settingsChrome(), environment("editMode", editing ? "active" : "inactive"))}>
        <Section>
          <List.ForEach onDelete={(indices) => indices.forEach((index) => hosts[index] && trustSite(hosts[index], false))}>
            {hosts.map((host) => (
              <Label key={host} title={host} icon={<Image systemName="globe" modifiers={[foregroundStyle(SECONDARY)]} />} />
            ))}
          </List.ForEach>
        </Section>
      </List>
      <Toolbar.Content>
        <ToolbarItem placement="topBarTrailing">
          <Button label={editing ? "Done" : "Edit"} onPress={() => setEditing(!editing)} modifiers={editing ? [font({ weight: "semibold" })] : []} />
        </ToolbarItem>
      </Toolbar.Content>
    </Toolbar>
  );
}

const FILTER_SYNTAX_URL = "https://github.com/gorhill/uBlock/wiki/Static-filter-syntax";
const MY_FILTERS_PLACEHOLDER = "||ads.example.com^\nexample.com##.newsletter-popup";

export function ExpoMyFiltersPage() {
  const state = useBlocking((s) => s.state);
  const saved = state?.myFilters ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? saved;
  const changed = draft !== null && draft !== saved;
  const [applying, setApplying] = useState(false);
  const applyingNow = useRef(false);
  const large = useWindowDimensions().fontScale >= settingsLayout.accessibilityFontScale;
  const apply = async () => {
    if (!changed || applyingNow.current) return;
    applyingNow.current = true;
    setApplying(true);
    await applyMyFilters(text);
    applyingNow.current = false;
    setApplying(false);
    setDraft(null);
    haptics.success();
  };
  return (
    <Toolbar>
      <VStack spacing={0} modifiers={modifierList(navigationTitle("My Filters"), navigationBarTitleDisplayMode("inline"), navigationBarBackButtonHidden(changed), tint(BLUE), settingsChrome())}>
        <ZStack alignment="topLeading">
          <FilterTextEditor text={text} onTextChange={setDraft} />
          {text ? null : (
            <Text modifiers={[font({ textStyle: "callout", design: "monospaced" }), foregroundStyle({ type: "hierarchical", style: "tertiary" }), padding({ leading: MY_FILTERS_INSET + 5, trailing: MY_FILTERS_INSET, top: 8 }), accessibilityHidden(true)]}>{MY_FILTERS_PLACEHOLDER}</Text>
          )}
        </ZStack>
        <VStack alignment="leading" spacing={4} modifiers={[frame({ maxWidth: FILL, alignment: "leading" }), padding({ horizontal: 16, vertical: 12 }), backgroundOverlay({ color: PlatformColor("secondarySystemBackground") })]}>
          <Text modifiers={[font({ textStyle: "footnote", weight: "semibold" }), changed ? legibleInk("orange") : foregroundStyle(SECONDARY), contentTransition("opacity")].filter((modifier) => modifier !== null)}>{myFiltersSummary(state?.myFiltersRuleCount ?? 0, state?.myFiltersSkippedCount ?? 0, changed)}</Text>
          {large ? null : <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(SECONDARY)]}>||site.com^ blocks a site. site.com##.ad hides part of a page. Lines that start with ! are notes.</Text>}
          <Button label="Filter Syntax" onPress={() => openFromSettings(FILTER_SYNTAX_URL)} modifiers={[buttonStyle("plain"), font({ textStyle: "footnote", weight: "semibold" }), foregroundStyle(BLUE)]} />
        </VStack>
      </VStack>
      <Toolbar.Content>
        {changed ? (
          <ToolbarItem placement="cancellationAction">
            <Button label="Revert" onPress={() => setDraft(null)} />
          </ToolbarItem>
        ) : null}
        <ToolbarItem placement="confirmationAction">{applying ? <ProgressView /> : <Button label="Apply" onPress={() => void apply()} modifiers={[buttonStyle("glassProminent"), disabled(!changed)]} />}</ToolbarItem>
      </Toolbar.Content>
    </Toolbar>
  );
}

const MY_FILTERS_INSET = 12;
