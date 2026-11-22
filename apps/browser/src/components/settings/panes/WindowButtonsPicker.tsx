import { PopUp, type Option } from "../../ui";
import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import type { Settings } from "../../../state/settings/settings";
import { windowButtonsChoosable } from "../../../lib/windowChrome";
import { Group, Row, SectionHeader } from "../Form";
import { t } from "../../../lib/uiLanguage";


const WINDOW_BUTTON_CHOICES: Option<Settings["windowButtons"]>[] = [
  { value: "native", title: t(`Native`) },
  { value: "trafficLights", title: t(`Traffic lights`) },
  { value: "hidden", title: t(`Hidden`) },
];

export function WindowButtonsPicker() {
  const windowButtons = useSettings((s) => s.windowButtons);
  if (!windowButtonsChoosable) return null;
  return (
    <>
      <SectionHeader title={t(`Window buttons`)} />
      <Group>
        <Row anchor="appearance.windowButtons">
          <PopUp value={windowButtons} options={WINDOW_BUTTON_CHOICES} onChange={(v) => updateSettings({ windowButtons: v })} minWidth={180} />
        </Row>
      </Group>
    </>
  );
}
