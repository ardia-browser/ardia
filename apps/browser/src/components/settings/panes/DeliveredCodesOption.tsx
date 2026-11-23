import { useEffect } from "react";
import { View } from "react-native";
import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import { useAppActive } from "../../../state/app/appActive";
import { openPrivacySettings, refreshDeliveredCodes, useDeliveredCodes } from "../../../state/vaults/deliveredCodes";
import { Button, Checkbox, space, Text } from "../../ui";

const DELIVERED_NEEDS_ACCESS = "Ardia needs Full Disk Access to read Messages and Mail.";

export function DeliveredCodesOption({ disabled }: { disabled: boolean }) {
  const on = useSettings((s) => s.vaultSuggestDeliveredCodes);
  const access = useDeliveredCodes((s) => s.access);
  const active = useAppActive();
  useEffect(() => {
    if (on && active) void refreshDeliveredCodes();
  }, [on, active]);
  const needsAccess = on && access === "needsAccess";
  return (
    <View style={NESTED}>
      <Checkbox value={on} disabled={disabled} label="Codes from Messages and Mail" onChange={(next) => updateSettings({ vaultSuggestDeliveredCodes: next })} />
      {needsAccess ? (
        <View style={STATUS}>
          <Text size="caption" tone="textSecondary">
            {DELIVERED_NEEDS_ACCESS}
          </Text>
          <View style={ACTION}>
            <Button title="Open Privacy & Security…" onPress={openPrivacySettings} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const NESTED = { paddingLeft: space.xxl + space.xxs } as const;
const STATUS = { marginTop: space.xxs, paddingLeft: space.xxl + space.xxs, gap: space.s, alignItems: "flex-start" } as const;
const ACTION = { marginTop: space.xxs } as const;
