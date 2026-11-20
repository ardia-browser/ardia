import { View } from "react-native";
import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import type { Settings } from "../../../state/settings/settings";
import { Checkbox, space, Text } from "../../ui";
import { Row } from "../Form";

type SuggestKey = keyof Pick<Settings, "vaultSuggestLogins" | "vaultSuggestCodes" | "vaultSuggestUsernames" | "vaultSuggestNewPasswords" | "vaultContextGenerate" | "vaultSuggestGenerated" | "vaultSuggestOnFocus">;

function SuggestCheckbox({ label, settingKey, disabled, nested }: { label: string; settingKey: SuggestKey; disabled?: boolean; nested?: boolean }) {
  const value = useSettings((s) => s[settingKey]);
  return (
    <View style={nested ? NESTED : undefined}>
      <Checkbox value={value} disabled={disabled} label={label} onChange={(on) => updateSettings({ [settingKey]: on })} />
    </View>
  );
}

export function VaultSuggestRow() {
  const newPasswords = useSettings((s) => s.vaultSuggestNewPasswords);
  return (
    <Row
      title="Suggest"
      description={
        <View>
          <Text size="caption" tone="textSecondary" style={CAPTION}>
            What the fill menu and the right-click menu offer.
          </Text>
          <View style={LIST}>
            <SuggestCheckbox label="Saved logins" settingKey="vaultSuggestLogins" />
            <SuggestCheckbox label="Verification codes" settingKey="vaultSuggestCodes" />
            <SuggestCheckbox label="Previous usernames" settingKey="vaultSuggestUsernames" />
            <SuggestCheckbox label="New passwords" settingKey="vaultSuggestNewPasswords" />
            <SuggestCheckbox label="New passwords in any text field" settingKey="vaultContextGenerate" disabled={!newPasswords} nested />
            <SuggestCheckbox label="Generated passwords" settingKey="vaultSuggestGenerated" />
          </View>
          <View style={LIST}>
            <SuggestCheckbox label="When a login field is focused" settingKey="vaultSuggestOnFocus" />
          </View>
        </View>
      }
    />
  );
}

const CAPTION = { marginTop: space.xxs } as const;
const LIST = { marginTop: space.m, gap: space.s } as const;
const NESTED = { paddingLeft: space.xxl + space.xxs } as const;
