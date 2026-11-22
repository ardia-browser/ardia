import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { chooseChatGPTEffort, chooseChatGPTModel, clearChatGPTProblem, connectChatGPT, disconnectChatGPT, openChatGPTUsage, refreshChatGPTAccount, useChatGPTAccount } from "../../state/browseForMe/store";
import { chatGPTEffortName, browseForMeSubtitle } from "../../state/browseForMe/copy";
import { popSettings } from "../../state/settings/nav";
import { ConfirmDialog, font, PrimaryButton, settingsTint, space, useTheme } from "../ui";
import { ButtonRow, Group, IconTile, PickerRow, SettingsPage, ValueRow } from "./SettingsKit";
import { t } from "../../lib/uiLanguage";


const PRIVACY = t(`Your search and the text of the pages it read go straight from this phone to OpenAI on your plan, never through a server of ours. Usage counts toward your ChatGPT limits.`);
const NEEDS_PLAN = t(`Needs ChatGPT Plus or Pro. Your search and the text of the pages it read go straight from this phone to OpenAI, never through a server of ours.`);

export function BrowseForMePage() {
  const theme = useTheme();
  const account = useChatGPTAccount();
  const [confirmsDisconnect, setConfirmsDisconnect] = useState(false);
  useEffect(() => {
    void refreshChatGPTAccount();
    return () => void clearChatGPTProblem();
  }, []);
  const connected = account?.connected ?? false;
  const model = account?.models.find((choice) => choice.slug === account.model) ?? account?.models[0] ?? null;
  const efforts = model?.efforts ?? [];
  return (
    <SettingsPage title={t(`Browse for Me`)} onBack={popSettings}>
      <View testID="browseForMeSettings" accessible style={styles.hero}>
        <IconTile icon="sparkleMagnifyingglass" tint={settingsTint.nightShade} side={56} />
        <Text accessibilityRole="header" style={[font.title3, styles.bold, { color: theme.label }]}>
          Browse for Me
        </Text>
        <Text style={[font.subheadline, styles.centered, { color: theme.secondaryLabel }]}>{browseForMeSubtitle(connected)}</Text>
      </View>
      {connected && account ? (
        <Group footer={PRIVACY}>
          <ValueRow title={t(`ChatGPT`)} value={account.label ?? t(`ChatGPT account`)} divider />
          {account.models.length > 1 && model ? (
            <PickerRow title={t(`Model`)} options={account.models.map((choice) => ({ id: choice.slug, title: choice.name }))} selected={model.slug} divider onSelect={(slug) => void chooseChatGPTModel(slug)} />
          ) : model ? (
            <ValueRow title={t(`Model`)} value={model.name} divider />
          ) : null}
          {efforts.length ? (
            <PickerRow
              title={t(`Thinking`)}
              options={[{ id: "", title: model?.defaultEffort ? `Automatic (${chatGPTEffortName(model.defaultEffort)})` : t(`Automatic`) }, ...efforts.map((effort) => ({ id: effort, title: chatGPTEffortName(effort) }))]}
              selected={account.effort ?? ""}
              divider
              onSelect={(effort) => void chooseChatGPTEffort(effort || null)}
            />
          ) : null}
          <ButtonRow title={t(`Check Usage`)} divider onPress={openChatGPTUsage} />
          <ButtonRow title={t(`Disconnect ChatGPT`)} destructive onPress={() => setConfirmsDisconnect(true)} />
        </Group>
      ) : (
        <View style={styles.connect}>
          <PrimaryButton title={account?.signingIn ? t(`Waiting for ChatGPT…`) : t(`Continue with ChatGPT`)} onPress={() => void connectChatGPT()} />
          {account?.problem ? <Text style={[font.footnote, { color: theme.destructive }]}>{account.problem}</Text> : null}
          <Text style={[font.footnote, { color: theme.secondaryLabel }]}>{NEEDS_PLAN}</Text>
        </View>
      )}
      {confirmsDisconnect ? (
        <ConfirmDialog
          confirmation={{ title: t(`Disconnect ChatGPT?`), message: t(`Browse for Me goes back to answering on this phone.`), action: t(`Disconnect`), run: () => void disconnectChatGPT() }}
          onClose={() => setConfirmsDisconnect(false)}
        />
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", gap: space.s, paddingHorizontal: space.xxl, paddingVertical: space.xl },
  bold: { fontWeight: "700" },
  centered: { textAlign: "center" },
  connect: { gap: space.s, paddingHorizontal: space.l },
});
