import type { PasswordManagerSpec } from "../../../lib/pluginPasswordManager";
import { useProfilesUsing } from "../../../state/site/passwordManager";
import { goToSettingsPane } from "../../../state/settings/settingsWindows";
import { Button } from "../../ui";
import { Group, Row, SectionHeader } from "../Form";
import { t } from "../../../lib/uiLanguage";


export function PasswordManagerDetails({ name, spec }: { name: string; spec: PasswordManagerSpec }) {
  const using = useProfilesUsing(name);
  return (
    <>
      <SectionHeader title={t(`Password manager`)} />
      <Group>
        <Row title={t(`Profiles`)} description={using.length ? `Used in ${using.join(", ")}.` : t(`No profile uses it yet. Pick it in Settings › Profiles › Passwords.`)}>
          <Button title={t(`Profiles…`)} onPress={() => goToSettingsPane("profiles", null)} />
        </Row>
      </Group>
    </>
  );
}
