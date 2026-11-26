import { useEffect, useState } from "react";
import { useWindowId } from "../../state/browser/hooks";
import { answerApproval, markApprovalShown, useVaultApproval, type ApprovalRequest } from "../../state/vault/approval";
import { programLabel, signerLine } from "../../state/vault/programs";
import { Box, Button, Checkbox, Dialog, DialogActions, DialogTitle, Symbol, Text } from "../ui";
import { useTheme } from "../ui/theme";

export function VaultApprovalHost() {
  const windowId = useWindowId();
  const request = useVaultApproval((s) => (s.request?.windowId === windowId ? s.request : null));
  const checking = useVaultApproval((s) => s.checking);
  if (!request) return null;
  return <VaultApprovalSheet key={request.id} request={request} checking={checking} />;
}

const hostOf = (origin: string) => origin.replace(/^https?:\/\//, "");

function VaultApprovalSheet({ request, checking }: { request: ApprovalRequest; checking: boolean }) {
  const theme = useTheme();
  const [always, setAlways] = useState(false);
  useEffect(() => markApprovalShown(request.id), [request.id]);
  const name = programLabel(request.program);
  const viaCommand = request.program.kind === "ardia";
  const asker = viaCommand ? "The agent" : name;
  const deny = () => answerApproval(request.id, "deny");
  return (
    <Dialog width="m" animated backdropCloses={false} onDismiss={deny}>
      <DialogTitle icon={<Symbol name="key.horizontal.fill" size={20} color={theme.icon} style={TITLE_ICON} />} subtitle={signerLine(request.program)}>
        {viaCommand ? "Let an agent sign in?" : `Let ${name} sign in?`}
      </DialogTitle>
      <Box gap="m" pad="m">
        <Box gap="xs">
          <Text size="small" tone="textSecondary">
            {request.sites.length === 1 ? "Site" : "Sites"}
          </Text>
          {request.sites.map((site) => (
            <Box key={site} row gap="s">
              <Symbol name="globe" size={13} color={theme.icon} style={ICON} />
              <Text weight="medium" numberOfLines={1} style={FILL}>
                {hostOf(site)}
              </Text>
            </Box>
          ))}
        </Box>
        {request.why ? (
          <Box gap="xs">
            <Text size="small" tone="textSecondary">
              It says why
            </Text>
            <Text numberOfLines={4}>{`“${request.why}”`}</Text>
          </Box>
        ) : null}
        <Text size="small" tone="textSecondary">
          {`Ardia signs in with the saved login${request.profileName ? ` from ${request.profileName}` : ""}. ${asker} never sees the password or the code. This lasts until the task ends.`}
        </Text>
        {request.program.claimed ? (
          <Text size="small" tone="textSecondary">{`It calls itself “${request.program.claimed}”, which Ardia can't check.`}</Text>
        ) : null}
      </Box>
      <DialogActions note={checking ? "Confirm with Touch ID or your password…" : undefined} leading={request.mayAlways ? <Checkbox value={always} disabled={checking} onChange={setAlways} label={`Always allow ${name} on ${request.sites.length === 1 ? "this site" : "these sites"}`} /> : undefined}>
        <Box row gap="s">
          <Button title="Don't Allow" disabled={checking} onPress={deny} />
          <Button title="Allow…" kind="primary" disabled={checking} onPress={() => answerApproval(request.id, always ? "always" : "allow")} />
        </Box>
      </DialogActions>
    </Dialog>
  );
}

const TITLE_ICON = { width: 28, height: 28 } as const;
const ICON = { width: 16, height: 16 } as const;
const FILL = { flex: 1 } as const;
