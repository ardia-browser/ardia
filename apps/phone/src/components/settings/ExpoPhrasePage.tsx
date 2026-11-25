import { useEffect, useState } from "react";
import { PlatformColor, View } from "react-native";
import { Button, Form, HStack, RNHostView, Section, Spacer, Text, TextField, Toolbar, ToolbarItem, useNativeState } from "@expo/ui/swift-ui";
import { autocorrectionDisabled, contentTransition, disabled, font, foregroundStyle, keyboardType, lineLimit, listRowBackground, monospacedDigit, navigationBarTitleDisplayMode, navigationTitle, onSubmit, privacySensitive, scrollDismissesKeyboard, submitLabel, textInputAutocapitalization, tint } from "@expo/ui/swift-ui/modifiers";
import { haptics } from "../../state/app/haptics";
import { syncWords } from "../../lib/sharedWords";
import { popSettings } from "../../state/settings/nav";
import { checkPhrase } from "../../state/sync/actions";
import { setConnectPhrase, useConnectDraft } from "../../state/sync/connectDraft";
import { phraseFooter } from "../../state/sync/syncRules";
import { PasteAction, SYSTEM_PASTE_SIZE } from "../sync/SyncPage";
import { legibleInk, modifierList, neverBounces, settingsChrome } from "../ui";

const SECONDARY = { type: "hierarchical", style: "secondary" } as const;

export function ExpoPhrasePage() {
  const [initial] = useState(() => useConnectDraft.getState().phrase);
  const text = useNativeState(initial);
  const [draft, setDraft] = useState(initial);
  const check = checkPhrase(draft);
  const footer = phraseFooter(check);
  useEffect(() => {
    if (check.isValid) haptics.success();
  }, [check.isValid]);
  const use = () => {
    if (!checkPhrase(draft).isValid) return;
    setConnectPhrase(draft);
    popSettings();
  };
  const paste = (pasted: string) => {
    text.set(pasted);
    setDraft(pasted);
  };
  const footerInk = footer.tone === "problem" ? legibleInk("red") : footer.tone === "good" ? legibleInk("green") : null;
  return (
    <Toolbar>
      <Form modifiers={modifierList(navigationTitle(syncWords.enterRecoveryPhrase), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome(), neverBounces(), scrollDismissesKeyboard("interactively"))}>
        <Section
          header={
            <HStack>
              <Text>Recovery Phrase</Text>
              <Spacer />
              <Text modifiers={modifierList(monospacedDigit(), check.isTooLong ? legibleInk("red") : foregroundStyle(SECONDARY))}>{check.counterText}</Text>
            </HStack>
          }
          footer={<Text modifiers={modifierList(contentTransition("opacity"), footerInk)}>{footer.text}</Text>}
        >
          <TextField
            text={text}
            placeholder="Enter your 24-word recovery phrase"
            axis="vertical"
            autoFocus={!initial}
            onTextChange={setDraft}
            modifiers={[lineLimit({ min: 5, max: 10 }), font({ textStyle: "body", design: "monospaced" }), textInputAutocapitalization("never"), autocorrectionDisabled(), keyboardType("ascii-capable"), privacySensitive(), submitLabel("done"), onSubmit(use)]}
          />
        </Section>
        {draft ? null : (
          <Section modifiers={[listRowBackground("clear")]}>
            <RNHostView matchContents>
              <View style={{ alignItems: "center", minHeight: SYSTEM_PASTE_SIZE.height }}>
                <PasteAction onText={paste} />
              </View>
            </RNHostView>
          </Section>
        )}
      </Form>
      <Toolbar.Content>
        <ToolbarItem placement="confirmationAction">
          <Button label="Use Phrase" onPress={use} modifiers={[disabled(!check.isValid)]} />
        </ToolbarItem>
      </Toolbar.Content>
    </Toolbar>
  );
}
