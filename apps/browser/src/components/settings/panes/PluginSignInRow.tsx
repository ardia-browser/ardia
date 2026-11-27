import { setPluginSignIn } from "../../../state/plugins/channelSites";
import { usePluginRecord } from "../../../state/plugins/hooks";
import { Symbol, Toggle } from "../../ui";
import { useTheme } from "../../ui/theme";
import { Row } from "../Form";

export function PluginSignInRow({ name, title, text, icon }: { name: string; title: string; text: string; icon: string }) {
  const theme = useTheme();
  const record = usePluginRecord(name);
  const on = record.sitesOff !== true;
  return (
    <Row title={text} description={on ? undefined : "Off: it can't use your sign-in until you turn this back on."} icon={<Symbol name={icon} size={13} color={theme.icon} style={ICON} />}>
      <Toggle value={on} accessibilityLabel={`Let ${title} use your sign-in`} onChange={(value) => void setPluginSignIn(name, value)} />
    </Row>
  );
}

const ICON = { width: 18, height: 18 } as const;
