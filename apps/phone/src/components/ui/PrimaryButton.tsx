import { ActionButton } from "./ActionButton";
import type { primaryActionRoles } from "./tokens";

export function PrimaryButton({ title, onPress, busy, disabled, testID }: { title: string; onPress: () => void; busy?: boolean; disabled?: boolean; testID?: string }) {
  return <ActionButton title={title} onPress={onPress} variant="filled" tone="accent" size={PRIMARY_ROLE} busy={busy} disabled={disabled} testID={testID} />;
}

const PRIMARY_ROLE = "hero" satisfies keyof typeof primaryActionRoles;
