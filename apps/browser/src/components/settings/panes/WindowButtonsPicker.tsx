import { PopUp, type Option } from "../../ui";
import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import type { Settings } from "../../../state/settings/settings";
import { windowButtonsChoosable } from "../../../lib/windowChrome";
import { Group, Row, SectionHeader } from "../Form";

const WINDOW_BUTTON_CHOICES: Option<Settings["windowButtons"]>[] = [
  { value: "native", title: "Native" },
  { value: "trafficLights", title: "Traffic lights" },
  { value: "hidden", title: "Hidden" },
];

export function WindowButtonsPicker() {
  const windowButtons = useSettings((s) => s.windowButtons);
  if (!windowButtonsChoosable) return null;
  return (
    <>
      <SectionHeader title="Window buttons" />
      <Group>
        <Row anchor="appearance.windowButtons">
          <PopUp value={windowButtons} options={WINDOW_BUTTON_CHOICES} onChange={(v) => updateSettings({ windowButtons: v })} minWidth={180} />
        </Row>
      </Group>
    </>
  );
}
