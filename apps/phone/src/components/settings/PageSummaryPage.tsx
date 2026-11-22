import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { clearChatGPTProblem, refreshChatGPTAccount, useChatGPTAccount } from "../../state/browseForMe/store";
import { choosePageSummaryChatGPT, choosePageSummaryProvider, refreshPageSummaryProvider, usePageSummaryProvider } from "../../state/pageSummary/store";
import { PAGE_SUMMARY_COPY } from "../../state/pageSummary/copy";
import { refreshPageSummariesEnabled, setPageSummariesEnabled, usePageSummariesEnabled } from "../../state/pageSummary/enabled";
import { popSettings } from "../../state/settings/nav";
import { font, PrimaryButton, settingsLayout, settingsTint, space, Symbol, useTheme } from "../ui";
import { Divider, Group, IconTile, SettingsPage, ToggleRow } from "./SettingsKit";
import { t } from "../../lib/uiLanguage";


export function PageSummaryPage() {
  const theme = useTheme();
  const account = useChatGPTAccount();
  const provider = usePageSummaryProvider();
  const enabled = usePageSummariesEnabled();
  useEffect(() => {
    void refreshChatGPTAccount();
    void refreshPageSummaryProvider();
    void refreshPageSummariesEnabled();
    return () => void clearChatGPTProblem();
  }, []);
  const connected = account?.connected ?? false;
  const signingIn = account?.signingIn ?? false;
  const choosesChatGPT = provider === "chatgpt";
  return (
    <SettingsPage title={PAGE_SUMMARY_COPY.title} onBack={popSettings}>
      <View testID="pageSummarySettings" accessible style={styles.hero}>
        <IconTile icon="sparkles" tint={settingsTint.nightShade} side={56} />
        <Text accessibilityRole="header" style={[font.title3, styles.bold, { color: theme.label }]}>
          {PAGE_SUMMARY_COPY.title}
        </Text>
        <Text style={[font.subheadline, styles.centered, { color: theme.secondaryLabel }]}>{PAGE_SUMMARY_COPY.subtitle}</Text>
      </View>
      <Group footer={enabled ? undefined : PAGE_SUMMARY_COPY.offFooter}>
        <ToggleRow title={PAGE_SUMMARY_COPY.title} value={enabled} onChange={(on) => void setPageSummariesEnabled(on)} />
      </Group>
      {enabled ? (
        <Group footer={choosesChatGPT ? PAGE_SUMMARY_COPY.chatGPTFooter : `${PAGE_SUMMARY_COPY.onDeviceFooter} ${PAGE_SUMMARY_COPY.chatGPTFooter}`}>
          <Choice title={PAGE_SUMMARY_COPY.onDevice} detail={PAGE_SUMMARY_COPY.onDeviceDetail} selected={!choosesChatGPT} onPress={() => void choosePageSummaryProvider("on_device")} />
          <Divider />
          <Choice
            title={PAGE_SUMMARY_COPY.chatGPT}
            detail={signingIn ? t(`Waiting for ChatGPT…`) : connected && account?.label ? account.label : PAGE_SUMMARY_COPY.chatGPTDetail}
            selected={choosesChatGPT}
            enabled={!signingIn}
            onPress={() => void choosePageSummaryChatGPT(connected)}
          />
        </Group>
      ) : null}
      {enabled && choosesChatGPT && !connected ? (
        <View style={styles.connect}>
          <PrimaryButton title={signingIn ? t(`Waiting for ChatGPT…`) : t(`Continue with ChatGPT`)} onPress={() => void choosePageSummaryChatGPT(false)} />
          <Text style={[font.footnote, { color: theme.secondaryLabel }]}>{PAGE_SUMMARY_COPY.reconnect}</Text>
        </View>
      ) : null}
      {account?.problem ? <Text style={[font.footnote, styles.problem, { color: theme.destructive }]}>{account.problem}</Text> : null}
    </SettingsPage>
  );
}

function Choice({ title, detail, selected, enabled = true, onPress }: { title: string; detail: string; selected: boolean; enabled?: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={`pageSummaryChoice:${title}`}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}
    >
      <View style={styles.fill}>
        <Text style={[font.body, { color: theme.label }]}>{title}</Text>
        <Text style={[font.footnote, { color: theme.secondaryLabel }]}>{detail}</Text>
      </View>
      {selected ? <Symbol name="checkmark" size={18} color={theme.formAccent} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", gap: space.s, paddingHorizontal: space.xxl, paddingVertical: space.xl },
  bold: { fontWeight: "700" },
  centered: { textAlign: "center" },
  connect: { gap: space.s, paddingHorizontal: space.l },
  problem: { paddingHorizontal: space.l, paddingTop: space.s },
  row: { flexDirection: "row", alignItems: "center", gap: settingsLayout.labelGap, minHeight: settingsLayout.rowMinHeight, paddingHorizontal: settingsLayout.rowInset, paddingVertical: 8 },
  fill: { flex: 1 },
});
