import { useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import { getPasskeyAccess, NO_PASSKEY_ACCESS, requestPasskeyAccess, type PasskeyAccess, type PasskeyAccessStatus } from "../../../state/engines/passkeys";
import { Button } from "../../ui";
import { Row } from "../Form";
import { t } from "../../../lib/uiLanguage";


const PASSKEY_STATUS: Record<Exclude<PasskeyAccessStatus, "entitlementRequired">, string> = {
  deviceNotConfigured: t(`Passkeys aren't set up on this Mac. Set up iCloud Keychain or another passkey app in System Settings, then reopen Ardia.`),
  notDetermined: t(`Allow Ardia to use the passkeys saved on this Mac, from the Passwords app and other passkey apps, in WebKit and Chromium pages.`),
  authorized: t(`Websites can use the passkeys saved on this Mac, in WebKit and Chromium pages.`),
  denied: t(`Off. Turn Ardia on in System Settings › Privacy & Security › Passkeys Access for Web Browsers.`),
};

export function PasskeyAccessRow({ waiting, title = t(`Passkeys`) }: { waiting: string; title?: string }) {
  const [access, setAccess] = useState<PasskeyAccess | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () => void getPasskeyAccess().catch(() => NO_PASSKEY_ACCESS).then((next) => live && setAccess(next));
    refresh();
    const watch = AppState.addEventListener("change", (state) => state === "active" && refresh());
    return () => {
      live = false;
      watch.remove();
    };
  }, []);
  if (!access?.entitled) return <Row title={title} description={waiting} />;
  const ask = async () => {
    setAsking(true);
    setAccess(await requestPasskeyAccess().catch(() => NO_PASSKEY_ACCESS));
    setAsking(false);
  };
  return (
    <Row title={title} description={PASSKEY_STATUS[access.status as keyof typeof PASSKEY_STATUS]}>
      {access.status === "notDetermined" && <Button title={t(`Allow Passkeys…`)} disabled={asking} onPress={() => void ask()} />}
      {access.status === "denied" && <Button title={t(`Open System Settings`)} onPress={() => void Linking.openURL("x-apple.systempreferences:com.apple.preference.security")} />}
    </Row>
  );
}
