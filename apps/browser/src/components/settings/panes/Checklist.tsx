import type { ReactNode } from "react";
import { View } from "react-native";
import { Checkbox, lineHeight, space, Text } from "../../ui";
import { perLook } from "../../ui/tokens";
import { Row } from "../Form";
import { setting, type SettingId } from "../settingsIndex";

export type ChecklistItem = { key: string; label: string; value: boolean; mixed?: boolean; disabled?: boolean; onChange: (on: boolean) => void };

export function Checklist({ anchor, description, items }: { anchor: SettingId; description?: ReactNode; items: ChecklistItem[] }) {
  const detail = description === undefined ? setting(anchor).description : description;
  return (
    <Row
      anchor={anchor}
      description={
        <View>
          {typeof detail === "string" ? (
            <Text size="caption" tone="textSecondary" style={DETAIL()}>
              {detail}
            </Text>
          ) : (
            detail
          )}
          <View style={ITEMS}>
            {items.map((item) => (
              <Checkbox key={item.key} value={item.value} mixed={item.mixed} disabled={item.disabled} label={item.label} onChange={(on) => item.onChange(on)} />
            ))}
          </View>
        </View>
      }
    />
  );
}

const DETAIL = perLook(() => ({ marginTop: space.xxs, lineHeight: lineHeight.caption }) as const);
const ITEMS = { marginTop: space.m, gap: space.s } as const;
