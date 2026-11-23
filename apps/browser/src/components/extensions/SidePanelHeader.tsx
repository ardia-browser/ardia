import type { ReactNode } from "react";
import { View } from "react-native";
import { Box, Button, Divider, Text } from "../ui";
import { GLYPH } from "../toolbar/tokens";
import { SIDE_PANEL_HEADER } from "./tokens";

export function SidePanelHeader({ icon, title, onClose, children }: { icon?: ReactNode; title: string; onClose: () => void; children?: ReactNode }) {
  return (
    <>
      <Box row gap="m" style={ROW}>
        {icon ? <View style={ICON_SLOT}>{icon}</View> : null}
        <Text numberOfLines={1} weight="medium" style={FLEX}>
          {title}
        </Text>
        {children}
        <Button variant="icon" icon="xmark" glyph={GLYPH} weight="medium" tooltip="Close Side Panel" onPress={onClose} />
      </Box>
      <Divider />
    </>
  );
}

const FLEX = { flex: 1 } as const;
const ROW = { height: SIDE_PANEL_HEADER.height, alignItems: "center", paddingLeft: SIDE_PANEL_HEADER.padLeft, paddingRight: SIDE_PANEL_HEADER.padRight } as const;
const ICON_SLOT = { width: SIDE_PANEL_HEADER.icon, height: SIDE_PANEL_HEADER.icon, alignItems: "center", justifyContent: "center" } as const;
