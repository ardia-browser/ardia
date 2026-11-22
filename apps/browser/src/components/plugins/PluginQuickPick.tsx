import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import type { QuickPickItem } from "../../lib/pluginProtocol";
import { resolveQuickPick } from "../../state/plugins/actions";
import type { QuickPickRequest } from "../../state/plugins/surfaces";
import { Badge, Box, Button, Dialog, EmptyState, ListRow, SearchField, Symbol, Text, useTheme } from "../ui";
import { usePluginTitle } from "../../state/plugins/hooks";
import { OVERLAY, SURFACE } from "./tokens";
import { fuzzyFilter, useRevealRow } from "./surfaceNodes";
import { t } from "../../lib/uiLanguage";


const itemFields = (item: QuickPickItem) => [item.title, item.subtitle, ...(item.keywords ?? [])];

export function PluginQuickPick({ request }: { request: QuickPickRequest }) {
  const { id, items, options } = request;
  const many = !!options.canPickMany;
  const pluginTitle = usePluginTitle(request.plugin);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(items.filter((i) => i.picked).map((i) => i.id)));
  const shown = useMemo(() => fuzzyFilter(items, query, itemFields), [items, query]);
  const at = Math.min(highlight, Math.max(0, shown.length - 1));
  const { scrollProps, rowLayout } = useRevealRow(shown[at]?.id ?? null);
  const cancel = () => resolveQuickPick(id, null);
  const confirm = () => resolveQuickPick(id, [...picked]);
  const toggle = (item: QuickPickItem) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  const choose = (item: QuickPickItem | undefined) => {
    if (!item) return;
    if (many) toggle(item);
    else resolveQuickPick(id, [item.id]);
  };
  return (
    <Dialog width="m" pad="m" animated onDismiss={cancel}>
      <Box gap="s">
        {options.title || pluginTitle ? (
          <Box row gap="s" padX="xs" style={CENTER}>
            <Text weight="semibold" numberOfLines={1} style={FLEX}>
              {options.title ?? pluginTitle}
            </Text>
            {options.title && pluginTitle ? (
              <Text size="caption" tone="textTertiary">
                {pluginTitle}
              </Text>
            ) : null}
          </Box>
        ) : null}
        <SearchField
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            setHighlight(0);
          }}
          placeholder={options.placeholder ?? t(`Search`)}
          autoFocus
          onEscape={cancel}
          onArrow={(step) => shown.length && setHighlight((at + step + shown.length) % shown.length)}
          onSubmit={() => (many ? confirm() : choose(shown[at]))}
        />
        <ScrollView {...scrollProps} style={LIST}>
          {shown.length ? (
            shown.map((item, index) => (
              <View key={item.id} onLayout={rowLayout(item.id)}>
                <PickRow item={item} highlighted={index === at} checked={many ? picked.has(item.id) : null} onPress={() => choose(item)} />
              </View>
            ))
          ) : (
            <EmptyState symbol="magnifyingglass" title={t(`No matches`)} />
          )}
        </ScrollView>
        {many ? (
          <Box row gap="s" style={FOOTER}>
            <Text size="caption" tone="textTertiary" style={FLEX}>
              {`${picked.size} selected`}
            </Text>
            <Button title={t(`Cancel`)} onPress={cancel} />
            <Button title={t(`Done`)} kind="primary" onPress={confirm} />
          </Box>
        ) : null}
      </Box>
    </Dialog>
  );
}

function PickRow({ item, highlighted, checked, onPress }: { item: QuickPickItem; highlighted: boolean; checked: boolean | null; onPress: () => void }) {
  const theme = useTheme();
  return (
    <ListRow selected={highlighted} height={SURFACE.itemHeight} onPress={onPress}>
      {checked !== null ? <Symbol name={checked ? "checkmark.circle.fill" : "circle"} size={SURFACE.icon} color={checked ? theme.formAccent : theme.textTertiary} style={ICON} /> : null}
      {item.icon ? <Symbol name={item.icon} size={SURFACE.icon} color={theme.icon} style={ICON} /> : null}
      <Box row gap="s" style={[FLEX, CENTER]}>
        <Text numberOfLines={1} style={SHRINK}>
          {item.title}
        </Text>
        {item.subtitle ? (
          <Text size="small" tone="textSecondary" numberOfLines={1} style={SHRINK}>
            {item.subtitle}
          </Text>
        ) : null}
      </Box>
      {item.badge ? <Badge text={item.badge} tone="chip" /> : null}
    </ListRow>
  );
}

const FLEX = { flex: 1 } as const;
const SHRINK = { flexShrink: 1 } as const;
const CENTER = { alignItems: "center" } as const;
const FOOTER = { alignItems: "center" } as const;
const LIST = { maxHeight: OVERLAY.quickPickHeight } as const;
const ICON = { width: SURFACE.iconBox, height: SURFACE.iconBox } as const;
