import { useEffect, useRef, type ReactNode } from "react";
import { View } from "react-native";
import { ActivitySpinner, Divider, Expand, Group, space, Text, useListPresence, useSecretEntry } from "../ui";
import { lineHeight } from "../ui/tokens";
import { SecretRow, type FieldHandle } from "./VaultSignInParts";
import { VAULT_SETTINGS, VAULT_SIGN_IN } from "./tokens";

export type StackRow = { key: string; render: () => ReactNode };

export function FieldStack({ rows, gap = true }: { rows: readonly StackRow[]; gap?: boolean }) {
  const { list, drop } = useListPresence(rows, (row) => row.key);
  const firstShown = list.find((entry) => entry.present)?.key;
  return (
    <View style={gap ? STACK_GAP : undefined}>
      <Group>
        <View>
          {list.map(({ key, item, present, appear }) => (
            <Expand key={key} open={present} appear={appear} onClosed={() => drop(key)}>
              {key !== firstShown ? <Divider thick inset="l" /> : null}
              {item.render()}
            </Expand>
          ))}
        </View>
      </Group>
    </View>
  );
}

export function OwnedSecretRow({
  fieldId,
  onEntry,
  ...row
}: Omit<Parameters<typeof SecretRow>[0], "entry"> & { fieldId: string; onEntry: (fieldId: string, entry: string | null) => void }) {
  const entry = useSecretEntry();
  const report = useRef(onEntry);
  report.current = onEntry;
  useEffect(() => {
    report.current(fieldId, entry);
    return () => report.current(fieldId, null);
  }, [fieldId, entry]);
  return <SecretRow {...row} entry={entry} />;
}

export function WaitingNote({ text }: { text: string }) {
  return (
    <View style={WAITING} accessibilityLiveRegion="polite">
      <ActivitySpinner style={SPINNER} />
      <Text size="small" tone="textSecondary" style={WAITING_TEXT}>
        {text}
      </Text>
    </View>
  );
}

export type { FieldHandle };

const STACK_GAP = { marginTop: space.xl } as const;
const WAITING = { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.s, marginTop: space.xl, maxWidth: VAULT_SIGN_IN.subtitleWidth, alignSelf: "center" } as const;
const SPINNER = { width: VAULT_SETTINGS.spinner, height: VAULT_SETTINGS.spinner } as const;
const WAITING_TEXT = { lineHeight: lineHeight.small, flexShrink: 1 } as const;
