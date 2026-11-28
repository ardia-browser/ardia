import { Image, View } from "react-native";
import { Button, Checkbox, space, Text } from "../../ui";
import { SectionHeader } from "../../settings/Form";
import { APP } from "../model";
import { ErrorText, FileDrop, FullDiskAccessSteps, Spacer, TargetPicker, Title } from "../Parts";
import { importLayout } from "../tokens";
import { backTo, canGoBackToChoose, closeImport, inRun, runStepLabel, setImportTarget, setSafariCookies, type ImportFlow } from "../../../state/import/flow";
import { recheckAccess, skipSource } from "../../../state/import/runImport";
import { importSafariDirect, importSafariExport, openFullDiskAccessSettings, pickSafariExport } from "../../../state/import/fileImports";

const EXPORT_STEPS = ["Open Safari", "File menu › Export Browsing Data to File", `Upload the .zip file to ${APP}`];

export function SafariBody({ flow }: { flow: ImportFlow }) {
  const { source, fullDiskAccess, safariCookies, step } = flow;
  const error = step.name === "safari" ? step.error : null;
  const drop = <FileDrop onFile={(path) => void importSafariExport(path, flow.turn)} onChoose={() => void pickSafariExport(flow.turn)} />;
  if (fullDiskAccess)
    return (
      <>
        <Title
          title="Import from Safari"
          subtitle={`Ardia can read Safari directly. Bring your bookmarks, history, Reading List, open tabs and sign-ins into ${APP}.`}
          turn={runStepLabel(flow)}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.l }}>
          {source?.iconPath ? <Image source={{ uri: `file://${source.iconPath}` }} style={{ width: importLayout.safariIcon, height: importLayout.safariIcon }} /> : null}
          <View style={{ flex: 1 }}>
            <Text weight="semibold">Bookmarks, history, Reading List and tabs</Text>
            <Text size="small" tone="textSecondary">
              Full Disk Access is granted.
            </Text>
            <View style={{ marginTop: space.m }}>
              <Checkbox label="Cookies (stay signed in)" value={safariCookies} onChange={(v) => setSafariCookies(v, flow.turn)} />
            </View>
          </View>
          <Button title="Import from Safari" kind="primary" onPress={() => void importSafariDirect(flow.turn)} />
        </View>
        <SectionHeader title="Passwords and payment cards can't be read directly — import them from an export file:" />
        {drop}
        {error && <ErrorText text={error} />}
      </>
    );
  return (
    <>
      <Title
        title="Give Ardia access to Safari"
        subtitle={`To import Safari's bookmarks, history and tabs directly, ${APP} needs Full Disk Access.`}
        turn={runStepLabel(flow)}
      />
      <FullDiskAccessSteps onOpen={openFullDiskAccessSettings} onRecheck={() => void recheckAccess(flow.turn)} />
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

function TurnFooter({ flow, picker }: { flow: ImportFlow; picker: boolean }) {
  const several = inRun(flow);
  return (
    <>
      {canGoBackToChoose(flow) && <Button title="Back" onPress={() => backTo("choose", flow.turn)} />}
      <Spacer />
      {picker && !several && <TargetPicker target={flow.target} onChange={(id) => setImportTarget(id, flow.turn)} />}
      {several && flow.source ? <Button title={`Skip ${flow.source.name}`} onPress={() => skipSource(flow.turn)} /> : null}
      <Button title="Cancel" onPress={closeImport} />
    </>
  );
}

export function SafariFooter({ flow }: { flow: ImportFlow }) {
  return <TurnFooter flow={flow} picker />;
}

export function AccessBody({ flow }: { flow: ImportFlow }) {
  const { source } = flow;
  if (!source) return null;
  return (
    <>
      <Title
        title={`Give ${APP} access to ${source.name}`}
        turn={runStepLabel(flow)}
        subtitle={`macOS protects ${source.name}'s data from other apps. To import your bookmarks, history, tabs, passwords and cookies, ${APP} needs Full Disk Access.`}
      />
      <FullDiskAccessSteps onOpen={openFullDiskAccessSettings} onRecheck={() => void recheckAccess(flow.turn)} />
    </>
  );
}

export function AccessFooter({ flow }: { flow: ImportFlow }) {
  if (!flow.source) return null;
  return <TurnFooter flow={flow} picker={false} />;
}
