import { useEffect, useState } from "react";
import { confirmConsentAs, consentOwner, dismissConsentAs, presentSettingsConsent } from "../../state/plugins/consentSurface";
import { usePluginConsent } from "../../state/plugins/hooks";
import { PluginConsentSheet } from "./PluginConsentSheet";

export function SettingsConsentSheet() {
  const asked = usePluginConsent();
  const [presenting, setPresenting] = useState(false);
  useEffect(() => {
    const stop = presentSettingsConsent();
    setPresenting(true);
    return stop;
  }, []);
  if (!presenting || !asked || consentOwner(asked) !== "settings") return null;
  return (
    <PluginConsentSheet
      key={`${asked.id}:${asked.hash}`}
      request={asked}
      onCancel={(id) => dismissConsentAs("settings", id)}
      onConfirm={(id) => confirmConsentAs("settings", id)}
      onClosed={() => {}}
    />
  );
}
