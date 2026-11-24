import { View } from "react-native";
import { AddressesPage as SharedAddressesPage, CardsPage as SharedCardsPage } from "../../browser/src/components/settings/panes/ProfileAutofill";
import { currentEngineProfile } from "../../browser/src/state/browser/current";
import { CredentialNotice } from "./CredentialNotice";

export function AddressesPage({ profileId }: { profileId: string }) {
  return (
    <View>
      <CredentialNotice kind="autofill" profile={currentEngineProfile(profileId)} />
      <SharedAddressesPage profileId={profileId} />
    </View>
  );
}

export function CardsPage({ profileId }: { profileId: string }) {
  return (
    <View>
      <CredentialNotice kind="autofill" profile={currentEngineProfile(profileId)} />
      <SharedCardsPage profileId={profileId} />
    </View>
  );
}
