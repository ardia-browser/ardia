import { Toggle } from "../../ui";
import { Row } from "../Form";

export function MeCardRow({ profile }: { profile: string }) {
  return (
    <Row anchor="profiles.meCard">
      <Toggle value={false} onChange={() => {}} />
    </Row>
  );
}
