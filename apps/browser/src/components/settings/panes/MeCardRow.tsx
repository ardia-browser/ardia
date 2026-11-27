import { openContactsPrivacy, switchMeCard, useMeCardFor } from "../../../state/site/meCard";
import { Box, Button, Toggle } from "../../ui";
import { Row } from "../Form";

export function MeCardRow({ profile }: { profile: string }) {
  const { on, hint, asking } = useMeCardFor(profile);
  return (
    <Row anchor="profiles.meCard" description={hint ?? undefined}>
      <Box row gap="s">
        {hint ? <Button title="Open System Settings" onPress={openContactsPrivacy} /> : null}
        <Toggle value={on} disabled={asking} onChange={(v) => void switchMeCard(profile, v)} />
      </Box>
    </Row>
  );
}
