import { t } from "../../../lib/i18n";
import { Image, View } from "react-native";
import { Button, Checkbox, space, Text } from "../../ui";
import { SectionHeader } from "../../settings/Form";
import { APP } from "../model";
import { ErrorText, FileDrop, FullDiskAccessSteps, Spacer, TargetPicker, Title } from "../Parts";
import { importLayout } from "../tokens";
import { backTo, closeImport, recheckAccess, setImportTarget, setSafariCookies, type ImportFlow } from "../../../state/import/flow";
import { chooseSafariExport, importSafariDirect, importSafariExport, openFullDiskAccessSettings } from "../../../state/import/fileImports";

const EXPORT_STEPS = [t("Open Safari"), t("File menu › Export Browsing Data to File"), t("Upload the .zip file to {app}", { app: APP })];

export function SafariBody({ flow }: { flow: ImportFlow }) {
  const { source, fullDiskAccess, safariCookies, step } = flow;
  const error = step.name === "safari" ? step.error : null;
  const drop = <FileDrop onFile={(path) => void importSafariExport(path)} onChoose={chooseSafariExport} />;
  if (fullDiskAccess)
    return (
      <>
        <Title title={t("Import from Safari")} subtitle={t("Ardia can read Safari directly. Bring your bookmarks, history, Reading List, open tabs and sign-ins into {app}.", { app: APP })} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.l }}>
          {source?.iconPath ? <Image source={{ uri: `file://${source.iconPath}` }} style={{ width: importLayout.safariIcon, height: importLayout.safariIcon }} /> : null}
          <View style={{ flex: 1 }}>
            <Text weight="semibold">{t("Bookmarks, history, Reading List and tabs")}</Text>
            <Text size="small" tone="textSecondary">
              {t("Full Disk Access is granted.")}
            </Text>
            <View style={{ marginTop: space.m }}>
              <Checkbox label={t("Cookies (stay signed in)")} value={safariCookies} onChange={setSafariCookies} />
            </View>
          </View>
          <Button title={t("Import from Safari")} kind="primary" onPress={() => void importSafariDirect()} />
        </View>
        <SectionHeader title="Passwords and payment cards can't be read directly — import them from an export file:" />
        {drop}
        {error && <ErrorText text={error} />}
      </>
    );
  return (
    <>
      <Title title={t("Give Ardia access to Safari")} subtitle={t("To import Safari's bookmarks, history and tabs directly, {app} needs Full Disk Access.", { app: APP })} />
      <FullDiskAccessSteps onOpen={openFullDiskAccessSettings} onRecheck={() => void recheckAccess()} />
      <SectionHeader title="Or import everything (including passwords) from an export file:" />
      <View style={{ gap: space.s, marginBottom: space.l }}>
        {EXPORT_STEPS.map((t, i) => (
          <Text key={t} size="small" tone="textSecondary">{`${i + 1}. ${t}`}</Text>
        ))}
      </View>
      {drop}
      {error && <ErrorText text={error} />}
    </>
  );
}

export function SafariFooter({ flow }: { flow: ImportFlow }) {
  return (
    <>
      <Button title={t("Back")} onPress={() => backTo("choose")} />
      <Spacer />
      <TargetPicker target={flow.target} onChange={setImportTarget} />
      <Button title={t("Cancel")} onPress={closeImport} />
    </>
  );
}

export function AccessBody({ flow }: { flow: ImportFlow }) {
  const { source } = flow;
  if (!source) return null;
  return (
    <>
      <Title
        title={t("Give {app} access to {source}", { app: APP, source: source.name })}
        subtitle={t("macOS protects {source}'s data from other apps. To import your bookmarks, history, tabs, passwords and cookies, {app} needs Full Disk Access.", { app: APP, source: source.name })}
      />
      <FullDiskAccessSteps onOpen={openFullDiskAccessSettings} onRecheck={() => void recheckAccess()} />
    </>
  );
}

export function AccessFooter({ flow }: { flow: ImportFlow }) {
  if (!flow.source) return null;
  return (
    <>
      <Button title={t("Back")} onPress={() => backTo("choose")} />
      <Spacer />
      <Button title={t("Cancel")} onPress={closeImport} />
    </>
  );
}
