import { View } from "react-native";
import { Button, Checkbox, space, Text } from "../../ui";
import { SectionHeader } from "../../settings/Form";
import { APP, diaTabsNote, KINDS, type ImportKind } from "../model";
import { ErrorText, Note, Spacer, TargetPicker, Title } from "../Parts";
import { BrowserRow } from "../Rows";
import { importType } from "../tokens";
import { chooseSource, closeImport, importsBySpaces, setImportTarget, toggleImportKind, type ImportFlow } from "../../../state/import/flow";
import { importBookmarksHtml } from "../../../state/import/fileImports";
import { continueImport } from "../../../state/import/runImport";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { t } from "../../../lib/uiLanguage";


const HIDDEN_KINDS: ImportKind[] = ["spaces", "pinnedTabs"];

export function ChooseBody({ flow }: { flow: ImportFlow }) {
  const { browsers, source, kinds, step } = flow;
  const bySpaces = importsBySpaces(source);
  const error = step.name === "choose" ? step.error : null;
  const appTabs = !!source?.asksAppForTabs;
  const diaTabs = appTabs || !!source?.profiles.some((p) => p.diaSidebar);
  const shown = !source
    ? []
    : KINDS.filter((k) => source.profiles.some((p) => p.available.includes(k.kind)) && (!HIDDEN_KINDS.includes(k.kind) || (diaTabs && k.kind === "pinnedTabs")));
  return (
    <>
      <Title title={t(`Import from Another Browser`)} subtitle={t(`Import once and stay in your flow. Your tabs, passwords, bookmarks and history come with you, and you stay signed in.`)} />
      {browsers.length === 0 ? (
        <Note text={`No other browsers with data to import were found on this ${PLATFORM_TERMS.computer}.`} />
      ) : (
        <View style={{ gap: space.s }}>
          {browsers.map((b) => (
            <BrowserRow key={b.id} browser={b} selected={source?.id === b.id} onPress={() => chooseSource(b)} />
          ))}
        </View>
      )}
      {source && !source.requiresExport && !source.needsFullDiskAccess && (
        <View>
          <SectionHeader title={t(`What to import`)} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xl }}>
            {shown.map((k) => (
              <Checkbox
                key={k.kind}
                label={k.kind === "tabs" && bySpaces ? t(`Spaces and tabs`) : k.kind === "tabs" && diaTabs ? t(`Open tabs`) : k.kind === "favorites" && source.sidebar === "zen" ? t(`Essentials`) : k.title}
                value={kinds.has(k.kind)}
                onChange={(v) => toggleImportKind(k.kind, v)}
              />
            ))}
          </View>
          {source && diaTabs && (
            <Text size="caption" tone="textSecondary" style={{ lineHeight: importType.smallLine, marginTop: space.ml }}>
              {diaTabsNote(source.profiles)}
            </Text>
          )}
        </View>
      )}
      {error && <ErrorText text={error} />}
    </>
  );
}

export function ChooseFooter({ flow }: { flow: ImportFlow }) {
  const { source, kinds } = flow;
  return (
    <>
      <Button title={t(`Bookmarks HTML File…`)} onPress={() => void importBookmarksHtml()} />
      <Spacer />
      <TargetPicker target={flow.target} onChange={setImportTarget} />
      <Button title={t(`Cancel`)} onPress={closeImport} />
      <Button title={t(`Continue`)} kind="primary" disabled={!source || (!source.requiresExport && !source.needsFullDiskAccess && kinds.size === 0)} onPress={continueImport} />
    </>
  );
}
