import { Fragment } from "react";
import { View } from "react-native";
import { groupedConsent, type ConsentLine } from "../../../state/plugins/consentLine";
import { ConsentChips } from "../../plugins/consent/ConsentParts";
import { Symbol, Text } from "../../ui";
import { useTheme } from "../../ui/theme";
import { lineHeight, space } from "../../ui/tokens";
import { Group, Row, SectionHeader } from "../Form";

export function PluginConsentRows({ lines }: { lines: readonly ConsentLine[] }) {
  const theme = useTheme();
  return groupedConsent(lines).map((section) => (
    <Fragment key={section.group}>
      <SectionHeader title={section.title} />
      <Group>
        {section.lines.map((line, index) => (
          <View key={`${index}:${line.text}`} accessible accessibilityLabel={line.text}>
            <Row title={line.title} description={<ConsentMore line={line} />} icon={<Symbol name={line.icon} size={13} color={theme.icon} style={ICON} />} />
          </View>
        ))}
      </Group>
    </Fragment>
  ));
}

function ConsentMore({ line }: { line: ConsentLine }) {
  if (!line.detail && !line.items) return null;
  return (
    <View style={MORE}>
      {line.detail ? (
        <Text size="caption" tone="textSecondary" style={DETAIL}>
          {line.detail}
        </Text>
      ) : null}
      {line.items ? <ConsentChips items={line.items} code={line.code === true} /> : null}
    </View>
  );
}

const ICON = { width: 18, height: 18 } as const;
const MORE = { marginTop: space.xxs } as const;
const DETAIL = { lineHeight: lineHeight.caption } as const;
