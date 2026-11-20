import type { ReactNode } from "react";
import { PlatformColor } from "react-native";
import { Button, Text, Toolbar, ToolbarItem } from "@expo/ui/swift-ui";
import { font, tint } from "@expo/ui/swift-ui/modifiers";
import { closeSettings } from "../../state/settings/nav";

export function ExpoSettingsDone({ children }: { children: ReactNode }) {
  return (
    <Toolbar>
      {children}
      <Toolbar.Content>
        <ToolbarItem placement="confirmationAction">
          <Button onPress={closeSettings} modifiers={[font({ weight: "semibold" }), tint(PlatformColor("systemBlue"))]}>
            <Text>Done</Text>
          </Button>
        </ToolbarItem>
      </Toolbar.Content>
    </Toolbar>
  );
}
