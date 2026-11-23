import { useEffect, useState } from "react";
import { confirmConsentAs, consentOwner, dismissConsentAs, presentSettingsConsent } from "../../state/plugins/consentSurface";
import { usePluginConsent } from "../../state/plugins/hooks";
import type { PluginsStore } from "../../state/plugins/store";
import { PluginConsentSheet } from "./PluginConsentSheet";

export function SettingsConsentSheet() {
  const asked = usePluginConsent();
  const [presenting, setPresenting] = useState(false);
  const [installing, setInstalling] = useState<PluginsStore["consent"]>(null);
  useEffect(() => {
    const stop = presentSettingsConsent();
    setPresenting(true);
    return stop;
  }, []);
  const owned = presenting && asked && consentOwner(asked) === "settings" ? asked : null;
  const shown = owned ?? installing;
  if (!shown) return null;
  return (
    <PluginConsentSheet
      key={`${shown.id}:${shown.hash}`}
      request={shown}
      onCancel={(id) => dismissConsentAs("settings", id)}
      onConfirm={(id) => {
        setInstalling(shown);
        return confirmConsentAs("settings", id);
      }}
      onClosed={() => setInstalling(null)}
    />
  );
}
