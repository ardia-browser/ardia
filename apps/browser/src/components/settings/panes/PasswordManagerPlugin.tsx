import type { PasswordManagerSpec } from "../../../lib/pluginPasswordManager";
import { useProfilesUsing } from "../../../state/site/passwordManager";
import { goToSettingsPane } from "../../../state/settings/settingsWindows";
import { Button } from "../../ui";
import { Group, Row, SectionHeader } from "../Form";

export function PasswordManagerDetails({ name, spec }: { name: string; spec: PasswordManagerSpec }) {
  const using = useProfilesUsing(name);
  return (
    <>
      <SectionHeader title="Password manager" />
      <Group>
        <Row title="Profiles" description={using.length ? `Used in ${using.join(", ")}.` : "No profile uses it yet. Pick it in Settings › Profiles › Passwords."}>
          <Button title="Profiles…" onPress={() => goToSettingsPane("profiles", null)} />
        </Row>
      </Group>
    </>
  );
}
