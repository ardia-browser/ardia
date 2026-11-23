import { Box, Text } from "../ui";
import { Row } from "../settings/Form";
import { hostLabel } from "../pages/PageLayout";
import { BrandBadge } from "./VaultParts";

export function WebsiteRow({ url }: { url: string }) {
  return (
    <Row title="Website">
      <Text lines={1} tone="textSecondary" selectable>
        {hostLabel(url)}
      </Text>
    </Row>
  );
}

export function SavedInRow({ provider, name }: { provider: string; name: string }) {
  return (
    <Row title="Saved In">
      <Box row gap="s" style={CENTER}>
        <BrandBadge provider={provider} />
        <Text tone="textSecondary">{name}</Text>
      </Box>
    </Row>
  );
}

const CENTER = { alignItems: "center" } as const;
