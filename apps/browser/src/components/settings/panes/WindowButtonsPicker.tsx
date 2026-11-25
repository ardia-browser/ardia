import { t } from "../../../lib/i18n";
import { PopUp, type Option } from "../../ui";
import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import type { Settings } from "../../../state/settings/settings";
import { windowButtonsChoosable } from "../../../lib/windowChrome";
import { Group, Row, SectionHeader } from "../Form";

const WINDOW_BUTTON_CHOICES: Option<Settings["windowButtons"]>[] = [
  { value: "native", title: t("Native") },
  { value: "trafficLights", title: t("Traffic lights") },
  { value: "hidden", title: t("Hidden") },
];

const WINDOW_BUTTON_DESCRIPTIONS: Record<Settings["windowButtons"], string> = {
  native: "Follows your desktop's button layout.",
  trafficLights: "Close, minimize and maximize at the top left.",
  hidden: "No window buttons; keeps the menu button in the header.",
};

export function WindowButtonsPicker() {
  const windowButtons = useSettings((s) => s.windowButtons);
  if (!windowButtonsChoosable) return null;
  return (
    <>
      <SectionHeader title="Window buttons" />
      <Group>
        <Row anchor="appearance.windowButtons" description={WINDOW_BUTTON_DESCRIPTIONS[windowButtons]}>
          <PopUp value={windowButtons} options={WINDOW_BUTTON_CHOICES} onChange={(v) => updateSettings({ windowButtons: v })} minWidth={180} />
        </Row>
      </Group>
    </>
  );
}
