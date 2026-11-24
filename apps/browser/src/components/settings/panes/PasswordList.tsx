import { memo, useCallback, useRef, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTheme } from "../../ui";
import { font, lineHeight, space } from "../../ui/tokens";
import { Favicon } from "../../favicon/Favicon";
import { Group, Row } from "../Form";
import { WindowedRows } from "../WindowedRows";
import type { PaneRows, VaultPaneRow } from "../../../state/vaults/paneRows";
import { brandOf } from "../../../state/vaults/brands";
import { BrandBadge } from "../../vaults/VaultParts";
import { VAULT_SETTINGS } from "../../vaults/tokens";
import { paneEntry, type SavedEntry } from "./savedEntries";

export const PREFETCH_ROWS = 100;

const NO_OPEN = () => undefined;

const PasswordRow = memo(function PasswordRow({ entry, onOpen }: { entry: SavedEntry | undefined; onOpen: (entry: SavedEntry) => void }) {
  const theme = useTheme();
  const icon = !entry ? <View style={ICON} /> : entry.url ? <Favicon url={entry.url} size={VAULT_SETTINGS.siteIcon} /> : <BrandBadge provider={entry.item?.provider ?? ""} />;
  return (
    <Row
      icon={icon}
      title={
        <Text numberOfLines={1} style={[font.body, { color: theme.textPrimary }]}>
          {entry?.site ?? " "}
        </Text>
      }
      description={
        <Text numberOfLines={1} style={[font.caption, { marginTop: space.xxs, color: theme.textSecondary, lineHeight: lineHeight.caption }]}>
          {entry ? entry.username || "No username" : " "}
        </Text>
      }
      onPress={entry ? () => onOpen(entry) : NO_OPEN}
    >
      {entry?.item ? <BrandBadge provider={entry.item.provider} tooltip={brandOf(entry.item.provider).name} /> : null}
    </Row>
  );
});

export function PasswordList({ rows, onOpen, empty }: { rows: PaneRows; onOpen: (entry: SavedEntry) => void; empty: ReactNode }) {
  const entries = useRef(new WeakMap<VaultPaneRow, SavedEntry>());
  const itemAt = (index: number) => {
    const row = rows.rowAt(index);
    if (!row) return undefined;
    const known = entries.current.get(row);
    if (known) return known;
    const entry = paneEntry(row);
    entries.current.set(row, entry);
    return entry;
  };
  const render = useCallback((entry: SavedEntry | undefined) => <PasswordRow entry={entry} onOpen={onOpen} />, [onOpen]);
  const want = useCallback((first: number, last: number) => rows.want(Math.max(0, first - PREFETCH_ROWS), last + PREFETCH_ROWS), [rows]);
  if (rows.total === 0) return rows.ready ? <Group>{empty}</Group> : null;
  return (
    <Group>
      <WindowedRows count={rows.total} itemAt={itemAt} render={render} onWindow={want} />
    </Group>
  );
}

const ICON = { width: VAULT_SETTINGS.siteIcon, height: VAULT_SETTINGS.siteIcon } as const;
