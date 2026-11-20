import type { PasswordManagerSpec } from "../../../lib/pluginPasswordManager";
import { useProfilesUsing } from "../../../state/site/passwordManager";
import { goToSettingsPane } from "../../../state/settings/settingsWindows";
import { Button } from "../../ui";
import { Group, Row, SectionHeader } from "../Form";
import { PasskeyAccessRow } from "./PasskeyAccessRow";

const PASSKEYS_NEED_GRANT = "Passkeys saved in Passwords don't work in Ardia yet. On sites that open in Chromium, you can sign in with a security key, or with a passkey on your phone by scanning the QR code.";

export function PasswordManagerDetails({ name, spec }: { name: string; spec: PasswordManagerSpec }) {
  const using = useProfilesUsing(name);
  return (
    <>
      <SectionHeader title="Password manager" />
      <Group>
        <Row title="Profiles" description={using.length ? `Used in ${using.join(", ")}.` : "No profile uses it yet. Pick it in Settings › Profiles › Passwords."}>
          <Button title="Profiles…" onPress={() => goToSettingsPane("profiles", null)} />
        </Row>
        {spec.passkeys === "system" ? <PasskeyAccessRow waiting={PASSKEYS_NEED_GRANT} /> : null}
      </Group>
    </>
  );
}
