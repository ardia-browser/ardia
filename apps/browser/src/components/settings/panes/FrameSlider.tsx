import type { ReactNode } from "react";
import { View } from "react-native";
import { Box, Button, Text } from "../../ui";
import { AmountSlider } from "../ThemeControls";
import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import { useBasePalette } from "../../../state/config/basePalette";
import { TAB_CORNERS, tabCornersControl } from "../../../lib/tabCorners";

const FRAME_SLIDER_WIDTH = 160;
const FRAME_VALUE_WIDTH = 36;
const FRAME_CONTROL = { alignItems: "center" } as const;

export function FrameSlider({ position, tooltip, label, onChange, children }: { position: number; tooltip: string; label: string; onChange: (value: number) => void; children?: ReactNode }) {
  return (
    <Box row gap="m" style={FRAME_CONTROL}>
      {children}
      <View style={{ width: FRAME_SLIDER_WIDTH }}>
        <AmountSlider value={position} tooltip={tooltip} onChange={onChange} />
      </View>
      <Text size="small" tone="textSecondary" style={{ width: FRAME_VALUE_WIDTH, textAlign: "right" }}>
        {label}
      </Text>
    </Box>
  );
}

export function TabCornersSlider() {
  const inForce = useBasePalette((s) => s.look.radii.chrome);
  const chosen = useSettings((s) => s.tabCornerRadius);
  const control = tabCornersControl(inForce, chosen);
  return (
    <FrameSlider position={control.position} tooltip={`${inForce} pt`} label={control.label} onChange={(v) => updateSettings({ tabCornerRadius: Math.round(v * TAB_CORNERS.max) })}>
      {control.followsTheme ? null : <Button variant="icon" icon="arrow.uturn.backward" size="m" onPress={() => updateSettings({ tabCornerRadius: null })} tooltip="Follow the Theme" />}
    </FrameSlider>
  );
}
