import { useEffect, useState } from "react";
import { View } from "react-native";
import type { PluginManifest, RowSpec, RowValue } from "../../../lib/pluginManifest";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import type { PluginListing, ProcessState, ProgramsState } from "../../../state/plugins/store";
import {
  consentLines,
  disablePlugin,
  pluginsFolderPath,
  relinkPrograms,
  canRelink,
  removePluginAfterConfirm,
  requestPluginConsent,
  turnOnApprovedPlugin,
  restartPlugin,
  setPluginValue,
  setPluginSecretRow,
  pluginSecretRowIsSet,
  showPluginLog,
  showPluginsFolder,
} from "../../../state/plugins/actions";
import { usePluginActive, usePluginListing, usePluginNeedsReview, usePluginProcess, usePluginPrograms, usePluginRecord, usePluginValues } from "../../../state/plugins/hooks";
import { goToSettingsPane, SETTINGS_WINDOW_ID, type SettingsPlace } from "../../../state/settings/settingsWindows";
import { Button, PopUp, Symbol, TextField, Toggle } from "../../ui";
import { Group, Row, SectionHeader } from "../Form";
import { useTheme } from "../../ui/theme";
import { PaneSubPage } from "./PaneSubPage";
import { releaseOrphanedConsent } from "../../../state/plugins/consentSurface";
import { OfficialPluginsSection, usePluginsBelowOfficial } from "./OfficialPlugins";
import { useControlTurnedOff } from "../../../state/app/programControlSetting";
import { useNeverChosenCount } from "../../../state/site/passwordManager";
import { PasswordManagerDetails } from "./PasswordManagerPlugin";

export function PluginsPane({ detail }: SettingsPlace) {
  if (!PLATFORM_FEATURES.plugins) return <UnavailablePage />;
  return detail ? <PluginPage name={detail} /> : <PluginList />;
}

function UnavailablePage() {
  return (
    <View>
      <SectionHeader anchor="plugins.plugins" />
      <Group>
        <Row title="Plugins aren't here yet" description={`Plugins aren't available on ${PLATFORM_TERMS.os} yet.`} />
      </Group>
    </View>
  );
}

function PluginList() {
  const order = usePluginsBelowOfficial();
  const [how, setHow] = useState(false);
  return (
    <View>
      <OfficialPluginsSection />
      <SectionHeader anchor="plugins.plugins" action={<Button title={`Show in ${PLATFORM_TERMS.fileManager}`} onPress={showPluginsFolder} />} />
      <Group of="plugins.plugins">
        {order.length ? (
          order.map((name) => <PluginRow key={name} name={name} />)
        ) : (
          <Row title="None yet" description={how ? `Put a plugin's folder in ${pluginsFolderPath()}, or run ardia plugins install <folder>.` : undefined}>
            {how ? null : <Button variant="text" look="link" pad="none" title="How to add one" onPress={() => setHow(true)} />}
          </Row>
        )}
      </Group>
    </View>
  );
}

function processText(p: ProcessState | undefined, onDemand = false): string | null {
  if (!p) return onDemand ? "Ready (on demand)" : null;
  if (p.state === "running") return "Running";
  if (p.state === "starting") return "Starting…";
  if (p.state === "waiting") return `Restarting after ${p.failures === 1 ? "a crash" : `${p.failures} crashes`}…`;
  if (p.state === "crashed") return `Its program crashed (${p.reason}) and was stopped`;
  if (p.state === "failed") return `Its program couldn't start: ${p.reason}`;
  return onDemand ? "Ready (on demand)" : "Its program finished";
}

function programsText(p: ProgramsState | undefined): string | null {
  if (!p) return null;
  if (p.state === "linking") return "Putting its commands on PATH…";
  if (p.state === "failed") return `Its commands couldn't go on PATH: ${p.reason}`;
  const refused = Object.values(p.refused);
  if (refused.length) return refused.join("; ");
  return p.linked.length ? `${p.linked.join(", ")} is on PATH (${p.binDir})` : null;
}

function originText(listing: PluginListing | undefined, active: boolean): string | null {
  if (listing?.ignoresUserFolder) return `Official (the folder of the same name in ${pluginsFolderPath()} is ignored)`;
  return listing?.official ? "Official" : null;
}

function statusOf(m: PluginManifest | null, problems: string[], active: boolean, review: boolean, p: ProcessState | undefined, describe = true): string {
  if (!m) return problems.slice(0, 2).join("; ") || "This plugin can't load";
  if (review) return "Its plugin.json changed. Review it to turn it back on.";
  const running = active ? processText(p, !!m.main) : null;
  return [describe ? m.description : null, running].filter(Boolean).join(" · ");
}

function setOn(name: string, on: boolean): Promise<unknown> | void {
  if (on) {
    if (turnOnApprovedPlugin(name)) return;
    releaseOrphanedConsent();
    requestPluginConsent(name);
  }
  else return disablePlugin(name);
}

function PluginRow({ name }: { name: string }) {
  const theme = useTheme();
  const listing = usePluginListing(name);
  const record = usePluginRecord(name);
  const active = usePluginActive(name);
  const review = usePluginNeedsReview(name);
  const process = usePluginProcess(name);
  const m = listing?.manifest ?? null;
  return (
    <Row
      title={m ? `${m.title}${m.version ? ` ${m.version}` : ""}` : name}
      description={[originText(listing, active), statusOf(m, listing?.problems ?? [], active, review, process)].filter(Boolean).join(" · ")}
      icon={<Symbol name={m?.icon ?? m?.page?.icon ?? "puzzlepiece"} size={14} color={theme.icon} style={ICON} />}
      onPress={() => goToSettingsPane("plugins", null, name)}
    >
      <Toggle value={active} disabled={!m} asksFirst={!active} accessibilityLabel={`Turn on ${m?.title ?? name}`} onChange={(on) => setOn(name, on || (record.enabled && review))} />
    </Row>
  );
}

function ValueRow({ name, row, value }: { name: string; row: RowSpec; value: RowValue }) {
  if (row.type === "toggle") return <Row title={row.title} description={row.description}><Toggle value={value === true} accessibilityLabel={row.title} onChange={(on) => setPluginValue(name, row.key, on)} /></Row>;
  if (row.type === "choice")
    return (
      <Row title={row.title} description={row.description}>
        <PopUp value={String(value)} options={row.choices.map((c) => ({ value: c.value, title: c.title }))} accessibilityLabel={row.title} onChange={(v) => setPluginValue(name, row.key, v)} />
      </Row>
    );
  if (row.type === "number") return <NumberRow name={name} row={row} value={typeof value === "number" ? value : row.default} />;
  if (row.type === "secret") return <SecretRow name={name} row={row} />;
  return <TextRow name={name} row={row} value={typeof value === "string" ? value : ""} />;
}

function TextRow({ name, row, value }: { name: string; row: Extract<RowSpec, { type: "text" }>; value: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = () => draft !== value && setPluginValue(name, row.key, draft);
  return (
    <Row title={row.title} description={row.description}>
      <TextField value={draft} width={200} onChangeText={setDraft} onSubmit={save} onBlur={save} />
    </Row>
  );
}

function numberProblem(row: Extract<RowSpec, { type: "number" }>, text: string): string | null {
  const n = Number(text.trim());
  if (!text.trim() || !Number.isFinite(n)) return "Enter a number.";
  if (row.min !== undefined && n < row.min) return `At least ${row.min}.`;
  if (row.max !== undefined && n > row.max) return `At most ${row.max}.`;
  if (row.step !== undefined && row.step > 0) {
    const steps = (n - (row.min ?? 0)) / row.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) return `In steps of ${row.step}.`;
  }
  return null;
}

function NumberRow({ name, row, value }: { name: string; row: Extract<RowSpec, { type: "number" }>; value: number }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const problem = numberProblem(row, draft);
  const save = () => {
    if (problem) return setDraft(String(value));
    const n = Number(draft.trim());
    if (n !== value) setPluginValue(name, row.key, n);
  };
  const range = [row.min !== undefined ? `min ${row.min}` : null, row.max !== undefined ? `max ${row.max}` : null].filter(Boolean).join(", ");
  return (
    <Row title={row.title} description={[row.description, problem && draft !== String(value) ? problem : range || null].filter(Boolean).join(" · ") || undefined}>
      <TextField value={draft} width={120} invalid={!!problem} onChangeText={setDraft} onSubmit={save} onBlur={save} onEscape={() => setDraft(String(value))} />
    </Row>
  );
}

function SecretRow({ name, row }: { name: string; row: Extract<RowSpec, { type: "secret" }> }) {
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void pluginSecretRowIsSet(name, row.key).then((set) => live && setSaved(set));
    return () => {
      live = false;
    };
  }, [name, row.key]);
  const write = async (value: string | null) => {
    setBusy(true);
    const outcome = await setPluginSecretRow(name, row.key, value);
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.message);
    setProblem(null);
    setDraft("");
    setSaved(value !== null && value !== "");
  };
  const status = problem ?? (saved === null ? null : saved ? `Saved in ${PLATFORM_TERMS.secretStore}` : "Not set");
  return (
    <Row title={row.title} description={[row.description, status].filter(Boolean).join(" · ") || undefined}>
      <TextField value={draft} width={180} secure placeholder={saved ? "••••••••" : row.placeholder} onChangeText={setDraft} onSubmit={() => draft && void write(draft)} />
      <Button title="Save" disabled={!draft || busy} onPress={() => void write(draft)} />
      {saved ? <Button title="Clear" disabled={busy} onPress={() => void write(null)} /> : null}
    </Row>
  );
}

async function confirmRemove(name: string, title: string) {
  if (await removePluginAfterConfirm(name, title, SETTINGS_WINDOW_ID)) goToSettingsPane("plugins");
}

function PluginPage({ name }: { name: string }) {
  const controlOff = useControlTurnedOff();
  const theme = useTheme();
  const listing = usePluginListing(name);
  const active = usePluginActive(name);
  const review = usePluginNeedsReview(name);
  const process = usePluginProcess(name);
  const programs = usePluginPrograms(name);
  const values = usePluginValues(name);
  const movesProfiles = useNeverChosenCount();
  const m = listing?.manifest ?? null;
  if (!listing) return <PaneSubPage intro="This plugin isn't installed any more.">{null}</PaneSubPage>;
  return (
    <PaneSubPage intro={m?.description || undefined}>
      <Group>
        <Row
          title={active ? "On" : review ? "Changed since you turned it on" : "Off"}
          description={[originText(listing, active), statusOf(m, listing.problems, active, review, process, false)].filter(Boolean).join(" · ") || undefined}
        >
          <Toggle value={active} disabled={!m} asksFirst={!active} accessibilityLabel={`Turn on ${m?.title ?? name}`} onChange={(on) => setOn(name, on)} />
        </Row>
        {active && (m?.process || (m?.main && process)) ? (
          <Row title={m?.process ? "Its program" : "Its code"} description={m?.process ? m.process.run.join(" ") : typeof m?.main === "string" ? m.main : m?.main?.entry}>
            <Button title="Show Log" onPress={() => showPluginLog(name)} />
            <Button title="Restart" onPress={() => restartPlugin(name)} />
          </Row>
        ) : null}
        {m?.programs.length && active ? (
          <Row title={m.programs.length === 1 ? "Its command" : "Its commands"} description={programsText(programs) ?? m.programs.map((p) => p.name).join(", ")}>
            {canRelink(programs) ? <Button title="Try Again" onPress={() => relinkPrograms(name)} /> : null}
          </Row>
        ) : null}
      </Group>
      {m && active && m.settings.rows.length ? (
        <>
          <SectionHeader title="Settings" />
          <Group>
            {m.settings.rows.map((row) => (
              <ValueRow key={row.key} name={name} row={row} value={values[row.key] ?? row.default} />
            ))}
          </Group>
        </>
      ) : null}
      {m?.passwordManager && active ? <PasswordManagerDetails name={name} spec={m.passwordManager} /> : null}
      {m ? (
        <>
          <SectionHeader title="What it gets" />
          <Group>
            {consentLines(m, { controlOff, official: !!listing.official && !active, movesProfiles }).map((line) => (
              <Row key={line.text} title={line.text} icon={<Symbol name={line.icon} size={13} color={theme.icon} style={ICON} />} />
            ))}
          </Group>
        </>
      ) : (
        <>
          <SectionHeader title="Problems" />
          <Group>
            {listing.problems.map((p) => (
              <Row key={p} title={p} />
            ))}
          </Group>
        </>
      )}
      <Group>
        <Row title="Remove" description={listing.official ? "Removes its download and its commands on your PATH. Its data stays." : `Moves the plugin to the ${PLATFORM_TERMS.trash}.`}>
          <Button title="Remove…" kind="destructive" onPress={() => void confirmRemove(name, m?.title ?? name)} />
        </Row>
      </Group>
    </PaneSubPage>
  );
}

const LINE = { flex: 1 } as const;
const ICON = { width: 18, height: 18 } as const;
const TITLE_ICON = { width: 28, height: 28 } as const;
