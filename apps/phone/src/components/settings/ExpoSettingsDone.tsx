import type { ReactNode } from "react";
import { PlatformColor } from "react-native";
import { Button, Toolbar, ToolbarItem } from "@expo/ui/swift-ui";
import { font, tint } from "@expo/ui/swift-ui/modifiers";
import { dismissWords } from "../../lib/sharedWords";
import { closeSettings } from "../../state/settings/nav";
import type { modifierList } from "../ui";

type Modifiers = ReturnType<typeof modifierList>;

export const DONE_PLACEMENT = "confirmationAction";

export const doneModifiers = [font({ weight: "semibold" }), tint(PlatformColor("systemBlue"))];

export function DoneButton({ onDone, modifiers = [] }: { onDone: () => void; modifiers?: Modifiers }) {
  return <Button label={dismissWords.done} onPress={onDone} modifiers={[...doneModifiers, ...modifiers]} />;
}

export function DoneToolbarItem({ onDone }: { onDone: () => void }) {
  return (
    <ToolbarItem placement={DONE_PLACEMENT}>
      <DoneButton onDone={onDone} />
    </ToolbarItem>
  );
}

export function ExpoSettingsDone({ children }: { children: ReactNode }) {
  return (
    <Toolbar>
      {children}
      <Toolbar.Content>
        <DoneToolbarItem onDone={closeSettings} />
      </Toolbar.Content>
    </Toolbar>
  );
}
