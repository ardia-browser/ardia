import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import type { PluginNode } from "../../lib/pluginProtocol";
import { ActivitySpinner, Badge, Box, ContextMenuArea, Divider, EmptyState, ListRow, SearchField, Text, useTheme } from "../ui";
import { ActionMenuButton, useActionMenu, useRunAction } from "./SurfaceActions";
import { SurfaceIcon } from "./SurfaceBasics";
import { SURFACE } from "./tokens";
import { actionsIn, bool, fillToneOf, flattenNodes, fuzzyScore, isHandlerRef, isNode, records, str, strings, useRevealRow, useSurface } from "./surfaceNodes";
import { ShortcutScopeContext, useDeeperShortcutScope, useShortcutRegistration, useSurfaceKeys } from "./surfaceShortcuts";
import { t } from "../../lib/uiLanguage";


type Entry = { kind: "section"; key: string; title?: string; subtitle?: string } | { kind: "item"; key: string; node: PluginNode; id: string };

const itemFields = (n: PluginNode) => [str(n.props.title), str(n.props.subtitle), ...strings(n.props.keywords)];

type ItemEntry = Extract<Entry, { kind: "item" }>;

function entriesOf(list: PluginNode, query: string, filtering: boolean): Entry[] {
  const out: Entry[] = [];
  const keep = (n: PluginNode) => n.type === "ListItem" || n.type === "ListSection";
  const matches = (entry: ItemEntry) => !filtering || fuzzyScore(query, itemFields(entry.node)) > 0;
  flattenNodes(list.children, keep).forEach((node, sectionIndex) => {
    if (node.type === "ListItem") {
      const entry = itemEntry(node, `i${sectionIndex}`);
      if (matches(entry)) out.push(entry);
      return;
    }
    const scope = `s${sectionIndex}`;
    const items = flattenNodes(node.children, (n) => n.type === "ListItem")
      .map((item, index) => itemEntry(item, `${scope}i${index}`, scope))
      .filter(matches);
    if (!items.length) return;
    out.push({ kind: "section", key: scope, title: str(node.props.title), subtitle: str(node.props.subtitle) });
    out.push(...items);
  });
  return out;
}

function itemEntry(node: PluginNode, fallback: string, scope = ""): ItemEntry {
  const id = str(node.props.id) ?? (node.key !== undefined ? `${scope}k:${String(node.key)}` : fallback);
  return { kind: "item", key: id, node, id };
}

export function ListNode({ node }: { node: PluginNode }) {
  const { fire, render } = useSurface();
  const run = useRunAction();
  const p = node.props;
  const [query, setQuery] = useState(str(p.searchText) ?? "");
  useEffect(() => {
    if (typeof p.searchText === "string") setQuery(p.searchText);
  }, [p.searchText]);
  const filtering = p.filtering !== false;
  const entries = useMemo(() => entriesOf(node, query, filtering), [node, query, filtering]);
  const items = entries.filter((e): e is ItemEntry => e.kind === "item");
  const [selected, setSelected] = useState<string | null>(str(p.selectedItemId) ?? null);
  useEffect(() => {
    if (typeof p.selectedItemId === "string") setSelected(p.selectedItemId);
  }, [p.selectedItemId]);
  const current = items.find((i) => i.id === selected) ?? items[0];
  const effective = current?.id ?? null;
  const notified = useRef(effective);
  const userPickedRef = useRef(false);
  const onSelectionChange = p.onSelectionChange;
  useEffect(() => {
    if (notified.current === effective) return;
    notified.current = effective;
    const gesture = userPickedRef.current;
    userPickedRef.current = false;
    if (isHandlerRef(onSelectionChange)) fire(onSelectionChange, [effective], { gesture });
  }, [effective, fire, onSelectionChange]);
  const { scrollProps, rowLayout } = useRevealRow(effective);
  const choose = (id: string) => {
    if (id !== effective) userPickedRef.current = true;
    setSelected(id);
  };
  const change = (text: string) => {
    setQuery(text);
    if (isHandlerRef(p.onSearchTextChange)) fire(p.onSearchTextChange, [text]);
  };
  const step = (by: 1 | -1) => {
    if (!items.length) return;
    const at = Math.max(0, items.findIndex((i) => i.id === current?.id));
    choose(items[(at + by + items.length) % items.length]!.id);
  };
  const activate = (entry: ItemEntry | undefined) => {
    if (!entry) return;
    choose(entry.id);
    if (isHandlerRef(entry.node.props.onSelect)) fire(entry.node.props.onSelect);
    else run(actionsIn(entry.node.props.actions)[0] ?? actionsIn(p.actions)[0]);
  };
  const detail = bool(p.isShowingDetail) && current && isNode(current.node.props.detail) ? current.node.props.detail : null;
  const currentNode = current?.node;
  const activeActions = useMemo(() => [...actionsIn(currentNode?.props.actions), ...actionsIn(p.actions)], [currentNode, p.actions]);
  useShortcutRegistration(activeActions);
  const keys = useSurfaceKeys();
  const deeper = useDeeperShortcutScope();
  return (
    <ShortcutScopeContext.Provider value={deeper}>
    <Box gap="s" style={FLEX}>
      <Box row gap="s" style={CENTER}>
        <SearchField value={query} onChangeText={change} placeholder={str(p.searchBarPlaceholder) ?? t(`Search`)} autoFocus onArrow={step} onSubmit={() => activate(current)} extraKeys={keys.keys} onExtraKey={keys.press} style={FLEX} />
        {bool(p.isLoading) ? <ActivitySpinner style={SPINNER} /> : null}
        <ActionMenuButton panel={p.actions} />
      </Box>
      <Box row gap="s" style={FLEX}>
        <ScrollView {...scrollProps} style={detail ? DETAIL_SPLIT : FLEX} contentContainerStyle={LIST}>
          {entries.length ? (
            entries.map((entry) =>
              entry.kind === "section" ? (
                <SectionHeader key={entry.key} title={entry.title} subtitle={entry.subtitle} />
              ) : (
                <View key={entry.key} onLayout={rowLayout(entry.id)}>
                  <ItemRow node={entry.node} selected={entry.id === current?.id} onPress={() => activate(entry)} />
                </View>
              ),
            )
          ) : isNode(p.emptyView) ? (
            render(p.emptyView, 0)
          ) : (
            <EmptyState symbol="magnifyingglass" title={query ? t(`No results`) : t(`Nothing here yet`)} />
          )}
        </ScrollView>
        {detail ? (
          <>
            <Divider vertical />
            <ScrollView style={FLEX}>{render(detail, 0)}</ScrollView>
          </>
        ) : null}
      </Box>
    </Box>
    </ShortcutScopeContext.Provider>
  );
}

function SectionHeader({ title, subtitle }: { title?: string; subtitle?: string }) {
  if (!title && !subtitle) return <Divider inset="s" />;
  return (
    <Box row gap="s" padX="m" padY="xs" style={CENTER}>
      {title ? <Text size="caption" weight="semibold" tone="textSecondary">{title}</Text> : null}
      {subtitle ? <Text size="caption" tone="textTertiary">{subtitle}</Text> : null}
    </Box>
  );
}

function ItemRow({ node, selected, onPress }: { node: PluginNode; selected: boolean; onPress: () => void }) {
  const menu = useActionMenu();
  const p = node.props;
  const subtitle = str(p.subtitle);
  return (
    <ContextMenuArea onContextMenu={() => void menu(p.actions)}>
      <ListRow selected={selected} height={SURFACE.itemHeight} onPress={onPress}>
        <SurfaceIcon name={str(p.icon)} />
        <Box row gap="s" style={[FLEX, CENTER]}>
          <Text numberOfLines={1} style={SHRINK}>{str(p.title) ?? ""}</Text>
          {subtitle ? <Text numberOfLines={1} tone="textSecondary" size="small" style={SHRINK}>{subtitle}</Text> : null}
        </Box>
        <Accessories values={records(p.accessories)} badge={str(p.badge)} />
      </ListRow>
    </ContextMenuArea>
  );
}

function Accessories({ values, badge }: { values: Record<string, unknown>[]; badge?: string }) {
  const theme = useTheme();
  return (
    <Box row gap="s" style={CENTER}>
      {values.map((a, index) => {
        const tag = str(a.tag);
        const role = fillToneOf(a.tone);
        return (
          <View key={index} tooltip={str(a.tooltip)} style={ROW_CENTER}>
            <SurfaceIcon name={str(a.icon)} tone={a.tone} />
            {tag ? <Badge text={tag} fill={role ? theme[role] : undefined} color={role ? theme.onAccent : undefined} tone="chip" /> : null}
            {str(a.text) ? <Text size="small" tone="textTertiary">{str(a.text)}</Text> : null}
          </View>
        );
      })}
      {badge ? <Badge text={badge} tone="chip" /> : null}
    </Box>
  );
}

const FLEX = { flex: 1 } as const;
const SHRINK = { flexShrink: 1 } as const;
const CENTER = { alignItems: "center" } as const;
const ROW_CENTER = { flexDirection: "row", alignItems: "center" } as const;
const LIST = { paddingBottom: SURFACE.iconBox } as const;
const DETAIL_SPLIT = { flex: 1 - SURFACE.detailWidth } as const;
const SPINNER = { width: SURFACE.spinner, height: SURFACE.spinner } as const;
