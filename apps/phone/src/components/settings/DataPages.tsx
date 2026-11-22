import { useState } from "react";
import { haptics } from "../../state/app/haptics";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { appVersion, clearBrowsingData, openFromSettings, websiteDataClearsByTime } from "../../state/settings/actions";
import { popSettings, pushSettings } from "../../state/settings/nav";
import { CLEAR_RANGES, clearChoice, clearFooter, clearIsEmpty, clearMessage, clearTitle, type ClearRange } from "../../state/settings/settingsRules";
import { AppIcon, appIconLayout, ConfirmSheet, font, settingsLayout, space, Symbol, useTheme, type Confirmation, type SymbolName } from "../ui";
import { copy } from "../../lib/platformCopy";
import { libraryCredits } from "../../state/settings/libraryCredits";
import { ButtonRow, Divider, Group, NavRow, PickerRow, SettingsPage, ToggleRow, ValueRow } from "./SettingsKit";
import { t } from "../../lib/uiLanguage";


export function ClearDataPage({ onBack = popSettings }: { onBack?: () => void }) {
  const [range, setRange] = useState<ClearRange>("today");
  const [history, setHistory] = useState(true);
  const [cache, setCache] = useState(true);
  const [cookies, setCookies] = useState(false);
  const [archive, setArchive] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const choice = clearChoice(history, cache, cookies, archive, range);
  const [byTime] = useState(websiteDataClearsByTime);
  const clear = async () => {
    haptics.warning();
    setClearing(true);
    await clearBrowsingData(choice, range);
    setClearing(false);
    onBack();
  };
  return (
    <SettingsPage title={t(`Clear Browsing Data`)} onBack={onBack}>
      <Group>
        <PickerRow title={t(`Time Range`)} options={CLEAR_RANGES} selected={range} onSelect={setRange} />
      </Group>
      <Group header={t(`Clear`)} footer={clearFooter(choice, range, byTime)}>
        <ToggleRow title={t(`History`)} value={history} divider onChange={setHistory} />
        <ToggleRow title={t(`Cache`)} value={cache} divider onChange={setCache} />
        <ToggleRow title={t(`Cookies and Site Data`)} value={cookies} divider={range === "allTime"} onChange={setCookies} />
        {range === "allTime" ? <ToggleRow title={t(`Archived Tabs`)} value={archive} onChange={setArchive} /> : null}
      </Group>
      <Group>
        <ButtonRow
          title={t(`Clear Data…`)}
          destructive
          enabled={!clearIsEmpty(choice) && !clearing}
          busy={clearing}
          onPress={(event) => setConfirmation({ title: clearTitle(choice, range, byTime), message: clearMessage(choice), action: t(`Clear Data`), run: () => void clear(), opener: event?.currentTarget })}
        />
      </Group>
      {confirmation ? <ConfirmSheet confirmation={confirmation} onClose={() => setConfirmation(null)} /> : null}
    </SettingsPage>
  );
}

function LinkRow({ title, icon, url, divider }: { title: string; icon: SymbolName; url: string; divider?: boolean }) {
  const theme = useTheme();
  return (
    <View>
      <Pressable accessibilityRole="link" accessibilityHint={t(`Opens in a new tab`)} onPress={() => openFromSettings(url)} style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}>
        <Symbol name={icon} size={22} color={theme.formAccent} />
        <Text style={[font.body, styles.fill, { color: theme.label }]}>{title}</Text>
        <Symbol name="arrowUpForward" size={13} color={theme.tertiaryLabel} />
      </Pressable>
      {divider ? <Divider inset={settingsLayout.rowInset + 22 + space.m} /> : null}
    </View>
  );
}

export function AboutPage() {
  const theme = useTheme();
  return (
    <SettingsPage title={t(`About Ardia`)} onBack={popSettings}>
      <View style={styles.hero}>
        <AppIcon side={appIconLayout.about} shadow />
        <View style={styles.heroText}>
          <Text accessibilityRole="header" style={[font.title, styles.heavy, styles.rounded, { color: theme.label }]}>
            Ardia
          </Text>
          <Text style={[font.subheadline, { color: theme.secondaryLabel }]}>{appVersion()}</Text>
        </View>
      </View>
      <Group footer={copy().privacy}>
        <LinkRow title="ardia.dev" icon="globe" url="https://ardia.dev" divider />
        <LinkRow title={t(`Release Notes`)} icon="sparkles" url="https://ardia.dev/release-notes" divider />
        <LinkRow title={t(`Source Code`)} icon="code" url="https://github.com/mantrakp04/ardia" />
      </Group>
      <Group>
        <NavRow title={t(`Open Source Licenses`)} onPress={() => pushSettings({ page: "licenses" })} />
      </Group>
    </SettingsPage>
  );
}

export const dataCredits = () => [
  { name: t(`Ardia`), use: copy().ardiaCredit, license: t(`Apache License 2.0`), url: "https://github.com/mantrakp04/ardia" },
  { name: t(`EasyList`), use: t(`The list behind Block Ads.`), license: t(`CC BY-SA 3.0 or GPLv3`), url: "https://easylist.to" },
  { name: t(`EasyPrivacy`), use: t(`The list behind Block Trackers.`), license: t(`CC BY-SA 3.0 or GPLv3`), url: "https://easylist.to" },
  { name: t(`Fanboy’s Cookie Monster List`), use: t(`The list behind Block Cookie Banners.`), license: t(`CC BY-SA 3.0 or GPLv3`), url: "https://secure.fanboy.co.nz" },
  { name: t(`Public Suffix List`), use: t(`Tells which part of an address is the site.`), license: t(`Mozilla Public License 2.0`), url: "https://publicsuffix.org" },
];

export const LIBRARY_CREDITS = libraryCredits(Platform.OS);

export function LicensesPage() {
  const theme = useTheme();
  return (
    <SettingsPage title={t(`Open Source Licenses`)} onBack={popSettings}>
      {dataCredits().map((credit) => (
        <Group key={credit.name}>
          <View style={styles.credit}>
            <Text style={[font.body, styles.bold, { color: theme.label }]}>{credit.name}</Text>
            <Text style={[font.subheadline, { color: theme.secondaryLabel }]}>{credit.use}</Text>
          </View>
          <Divider />
          <ValueRow title={t(`License`)} value={credit.license} divider />
          <Pressable accessibilityRole="link" onPress={() => openFromSettings(credit.url)} style={styles.row}>
            <Text style={[font.body, { color: theme.formAccent }]} numberOfLines={1}>
              {credit.url.replace(/^https:\/\//, "")}
            </Text>
          </Pressable>
        </Group>
      ))}
      <Group header={t(`Code in This App`)}>
        {LIBRARY_CREDITS.map((credit, index) => (
          <View key={`${credit.name}@${credit.detail}`}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`${credit.name}, ${credit.license}`}
              onPress={() => openFromSettings(credit.url)}
              style={({ pressed }) => [styles.library, pressed ? { backgroundColor: theme.rowHighlight } : null]}
            >
              <View style={styles.fill}>
                <Text style={[font.body, { color: theme.label }]} numberOfLines={1}>
                  {credit.name}
                </Text>
                <Text style={[font.footnote, { color: theme.secondaryLabel }]} numberOfLines={2}>
                  {credit.detail}
                </Text>
              </View>
              <Text style={[font.footnote, { color: theme.secondaryLabel }]}>{credit.license}</Text>
            </Pressable>
            {index < LIBRARY_CREDITS.length - 1 ? <Divider /> : null}
          </View>
        ))}
      </Group>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.m, minHeight: settingsLayout.rowMinHeight, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.s },
  fill: { flex: 1 },
  hero: { alignItems: "center", gap: space.s },
  heroText: { alignItems: "center", gap: space.hair },
  heavy: { fontWeight: "700" },
  rounded: { fontFamily: Platform.select({ ios: "ui-rounded", default: undefined }) },
  bold: { fontWeight: "600" },
  library: { flexDirection: "row", alignItems: "center", gap: space.m, minHeight: settingsLayout.rowMinHeight, paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.s },
  credit: { paddingHorizontal: settingsLayout.rowInset, paddingVertical: space.m, gap: space.xs },
});
