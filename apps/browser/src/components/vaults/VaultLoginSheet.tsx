import { useState } from "react";
import { View } from "react-native";
import type { VaultItem } from "../../state/vaults/types";
import { copyFailureMessage, copyFromManager, type VaultCopyField } from "../../state/vaults/actions";
import { brandOf } from "../../state/vaults/brands";
import { useVaultProvider } from "../../state/vaults/hooks";
import { closeSettingsSheet, showSettingsSheet } from "../../state/settings/sheet";
import { openUrls } from "../../state/browser/actions";
import { LoginFormSheet } from "./LoginFormSheet";
import { Box, Button, DialogActions, DialogTitle, Expand, Sheet, space, Text } from "../ui";
import { Favicon } from "../favicon/Favicon";
import { Group, Row } from "../settings/Form";
import { itemUrl } from "./rowText";
import { BrandBadge, CopyButton } from "./VaultParts";
import { VAULT_SETTINGS } from "./tokens";

const PROTON = "protonpass";
const PROTON_PASS_WEB = "https://pass.proton.me";

export function VaultLoginSheet({ item, site }: { item: VaultItem; site: string }) {
  const provider = useVaultProvider(item.provider);
  const name = provider?.name ?? brandOf(item.provider).name;
  const editable = provider?.state === "unlocked" && provider.capabilities.edit === true;
  const url = itemUrl(item);
  const [problem, setProblem] = useState("");
  const copy = (field: VaultCopyField) => async () => {
    const outcome = await copyFromManager(item.provider, item.id, field);
    setProblem(copyFailureMessage(outcome, field, item.provider));
    return outcome;
  };
  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle icon={url ? <Favicon url={url} size={VAULT_SETTINGS.siteIcon} /> : <BrandBadge provider={item.provider} />}>{site || item.title || name}</DialogTitle>
      <View style={SHEET_BODY}>
        <Group>
          {url ? <Row title="Website" description={url} /> : null}
          <Row title="Username">
            <Box row gap="xs" style={CENTER}>
              <Text selectable>{item.username || "No Username"}</Text>
              {item.username ? <CopyButton label="Username" onCopy={copy("username")} /> : null}
            </Box>
          </Row>
          <Row title="Password">
            <Box row gap="xs" style={CENTER}>
              <Text>••••••••</Text>
              <CopyButton label="Password" onCopy={copy("password")} />
            </Box>
          </Row>
          <Row title="Saved In" icon={<BrandBadge provider={item.provider} />}>
            <Text tone="textSecondary">{name}</Text>
          </Row>
        </Group>
        <Expand open={!!problem}>
          <Text size="caption" tone="destructive" style={ERROR}>
            {problem}
          </Text>
        </Expand>
      </View>
      <DialogActions>
        {editable ? (
          <Button title="Edit" onPress={() => showSettingsSheet(<LoginFormSheet target={{ kind: "manager", item }} />)} />
        ) : item.provider === PROTON ? (
          <Button title="Open Proton Pass" onPress={() => (closeSettingsSheet(), openUrls([PROTON_PASS_WEB]))} />
        ) : null}
        <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
      </DialogActions>
    </Sheet>
  );
}

const SHEET_BODY = { marginTop: space.xl } as const;
const ERROR = { marginTop: space.ml } as const;
const CENTER = { alignItems: "center" } as const;
