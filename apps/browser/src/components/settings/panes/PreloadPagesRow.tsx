import { profileEngine as currentEngineProfile } from "../../../state/profiles/current";
import { preloadPages, setPreloadPagesFor } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { Toggle } from "../../ui";
import { Row } from "../Form";
import { setting } from "../settingsIndex";

export function PreloadPagesRow({ profileId }: { profileId: string }) {
  const profile = currentEngineProfile(profileId);
  const [on = false] = useResource(preloadPages, profile);
  return (
    <Row anchor="profiles.preloadPages">
      <Toggle value={on} accessibilityLabel={setting("profiles.preloadPages").title} onChange={(v) => void setPreloadPagesFor(profile, v)} />
    </Row>
  );
}
