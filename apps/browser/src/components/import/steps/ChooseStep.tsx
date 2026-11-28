import { View } from "react-native";
import { Button, Checkbox, space, Text } from "../../ui";
import { SectionHeader } from "../../settings/Form";
import { diaTabsNote, KINDS, type ImportKind } from "../model";
import { ErrorText, Note, Spacer, TargetPicker, Title } from "../Parts";
import { BrowserRow } from "../Rows";
import { importType } from "../tokens";
import { closeImport, importsBySpaces, kindsShownFor, pickedBrowsers, setImportTarget, toggleImportKind, toggleSource, type ImportFlow } from "../../../state/import/flow";
import type { BrowserSource } from "../../../state/import/apply";
import { importBookmarksHtml } from "../../../state/import/fileImports";
import { continueImport } from "../../../state/import/runImport";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { spokenList } from "../../../lib/lists";

const HIDDEN_KINDS: ImportKind[] = ["spaces", "pinnedTabs"];

const readsDiaTabs = (b: BrowserSource) => !!b.asksAppForTabs || b.profiles.some((p) => p.diaSidebar);
const hasKind = (b: BrowserSource, kind: ImportKind) => b.profiles.some((p) => p.available.includes(kind));

function kindLabel(kind: ImportKind, title: string, holders: BrowserSource[]) {
  if (kind === "tabs" && holders.every((b) => importsBySpaces(b))) return "Spaces and tabs";
  if (kind === "tabs" && holders.every(readsDiaTabs)) return "Open tabs";
  if (kind === "favorites" && holders.every((b) => b.sidebar === "zen")) return "Essentials";
  return title;
}

export function ChooseBody({ flow }: { flow: ImportFlow }) {
  const { browsers, picked, kinds, step } = flow;
  const error = step.name === "choose" ? step.error : null;
  const listed = pickedBrowsers(flow).filter(kindsShownFor);
  const several = listed.length > 1;
  const diaSources = listed.filter(readsDiaTabs);
  const diaTabs = diaSources.length > 0;
  const shown = KINDS.flatMap((k) => {
    const holders = listed.filter((b) => hasKind(b, k.kind));
    if (!holders.length || (HIDDEN_KINDS.includes(k.kind) && !(diaTabs && k.kind === "pinnedTabs"))) return [];
    const only = several && holders.length < listed.length ? `${spokenList(holders.map((b) => b.name))} only` : null;
    return [{ ...k, label: kindLabel(k.kind, k.title, holders), only }];
  });
  return (
    <>
      <Title title="Import from Another Browser" subtitle="Import once and stay in your flow. Your tabs, passwords, bookmarks and history come with you, and you stay signed in." />
      {browsers.length === 0 ? (
        <Note text={`No other browsers with data to import were found on this ${PLATFORM_TERMS.computer}.`} />
      ) : (
        <View style={{ gap: space.s }}>
          {browsers.map((b) => (
            <BrowserRow key={b.id} browser={b} selected={picked.includes(b.id)} onPress={() => toggleSource(b)} />
          ))}
        </View>
      )}
      {listed.length > 0 && (
        <View>
          <SectionHeader title="What to import" />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xl }}>
            {shown.map((k) => (
              <View key={k.kind} style={{ flexDirection: "row", alignItems: "center", gap: space.s }}>
                <Checkbox label={k.label} value={kinds.has(k.kind)} onChange={(v) => toggleImportKind(k.kind, v)} />
                {k.only ? (
                  <Text size="caption" tone="textTertiary">
                    {k.only}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
          {diaSources.map((b) => (
            <Text key={b.id} size="caption" tone="textSecondary" style={{ lineHeight: importType.smallLine, marginTop: space.ml }}>
              {diaTabsNote(b.profiles)}
            </Text>
          ))}
        </View>
      )}
      {error && <ErrorText text={error} />}
    </>
  );
}

export function ChooseFooter({ flow }: { flow: ImportFlow }) {
  const { kinds } = flow;
  const chosen = pickedBrowsers(flow);
  const nothing = !chosen.length || (chosen.every(kindsShownFor) && kinds.size === 0);
  return (
    <>
      <Button title="Bookmarks HTML File…" onPress={() => void importBookmarksHtml()} />
      <Spacer />
      <TargetPicker target={flow.target} onChange={(id) => setImportTarget(id, flow.turn)} />
      <Button title="Cancel" onPress={closeImport} />
      <Button title="Continue" kind="primary" disabled={nothing} onPress={() => continueImport("choose", flow.turn)} />
    </>
  );
}
