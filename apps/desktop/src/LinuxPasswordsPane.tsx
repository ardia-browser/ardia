import { View } from "react-native";
import { PasswordsPage as SharedPasswordsPage, PasswordsSection } from "../../browser/src/components/settings/panes/ProfilePasswords";
import { currentEngineProfile } from "../../browser/src/state/browser/current";
import { CredentialNotice } from "./CredentialNotice";

export { PasswordsSection };

export function PasswordsPage({ profileId }: { profileId: string }) {
  return (
    <View>
      <CredentialNotice kind="passwords" profile={currentEngineProfile(profileId)} />
      <SharedPasswordsPage profileId={profileId} />
    </View>
  );
}
