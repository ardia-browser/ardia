import { Box, Button, PopUp } from "../../ui";
import { chooseInterfaceScale } from "../../../state/settings/actions";
import { useCurrentInterfaceScale } from "../../../state/settings/interfaceScale";
import { INTERFACE_SCALE, INTERFACE_SCALE_STEPS, interfaceScaleLabel, interfaceScalePercent, sameInterfaceScale } from "../../../lib/interfaceScale";

const SCALE_OPTIONS = INTERFACE_SCALE_STEPS.map((scale) => ({ value: String(interfaceScalePercent(scale)), title: interfaceScaleLabel(scale) }));
const CONTROL = { alignItems: "center" } as const;

export function InterfaceSizeControl() {
  const scale = useCurrentInterfaceScale();
  const atDefault = sameInterfaceScale(scale, INTERFACE_SCALE.default);
  return (
    <Box row gap="s" style={CONTROL}>
      {atDefault ? null : <Button variant="icon" icon="arrow.uturn.backward" size="m" onPress={() => chooseInterfaceScale(INTERFACE_SCALE.default)} tooltip="Back to 100%" />}
      <PopUp value={String(interfaceScalePercent(scale))} options={SCALE_OPTIONS} onChange={(percent) => chooseInterfaceScale(Number(percent) / 100)} minWidth={90} accessibilityLabel="Interface size" />
    </Box>
  );
}
