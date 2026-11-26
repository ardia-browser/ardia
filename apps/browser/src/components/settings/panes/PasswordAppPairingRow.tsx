import { Button } from "../../ui";
import { Group, Row, SectionHeader } from "../Form";
import { passwordAppPairing } from "../../../state/extensions/passwordAppPairing";
import { openPasswordApp, pairsWithPasswordApp } from "../../../state/extensions/passwordAppPairingPrompt";

export function PasswordAppPairingRow({ extensionId }: { extensionId: string }) {
  const pairing = pairsWithPasswordApp(extensionId) ? passwordAppPairing() : null;
  if (!pairing) return null;
  const { appPath } = pairing;
  return (
    <>
      <SectionHeader title="Desktop app" />
      <Group>
        <Row title={pairing.title} description={pairing.steps}>
          {appPath ? <Button title="Open 1Password" onPress={() => openPasswordApp(appPath)} /> : null}
        </Row>
      </Group>
    </>
  );
}
