import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { PluginManifest, RowSpec, RowValue } from "../../../lib/pluginManifest";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import type { PluginListing, ProcessState, ProgramsState } from "../../../state/plugins/store";
import {
  consentLines,
  fullControlLine,
  FULL_CONTROL_SUMMARY,
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
  UNSAVED,
  reviewUpdate,
  rollbackPlugin,
  setPluginChannel,
  setPluginProfiles,
} from "../../../state/plugins/actions";
import { usePluginActive, usePluginListing, usePluginLockEntry, usePluginNeedsReview, usePluginOrder, usePluginProcess, usePluginPrograms, usePluginRecord, usePluginUnsaved, usePluginValues } from "../../../state/plugins/hooks";
import { useProfileOrder, useProfileRecords } from "../../../state/profiles/hooks";
import { goToSettingsPane, SETTINGS_WINDOW_ID, type SettingsPlace } from "../../../state/settings/settingsWindows";
import { Button, PopUp, Symbol, Text, TextField, Toggle } from "../../ui";
import { radius, space } from "../../ui/tokens";
import { Group, ProfilePicker, Row, SectionHeader, useSettingsProfile } from "../Form";
import { useTheme } from "../../ui/theme";
import { PaneSubPage } from "./PaneSubPage";
import { releaseOrphanedConsent } from "../../../state/plugins/consentSurface";
import { MarketplaceSection, RegistriesSection } from "./PluginMarketplace";
import { useControlTurnedOff } from "../../../state/app/programControlSetting";
import { useNeverChosenCount } from "../../../state/site/passwordManager";
import { PasswordManagerDetails } from "./PasswordManagerPlugin";
import { updateNoteText } from "../../../state/plugins/featured";
import { PluginHealthDetails } from "./PluginHealthDetails";

export function PluginsPane({ detail }: SettingsPlace) {
  if (!PLATFORM_FEATURES.plugins) return <UnavailablePage />;
  if (detail?.startsWith("get:")) return <PluginList getting={detail.slice(4)} />;
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

function PluginList({ getting }: { getting?: string }) {
  const order = usePluginOrder();
  const [how, setHow] = useState(false);
  return (
    <View>
      <MarketplaceSection getting={getting ?? null} />
      <SectionHeader anchor="plugins.plugins" action={<Button title={`Show in ${PLATFORM_TERMS.fileManager}`} onPress={showPluginsFolder} />} />
      <Group of="plugins.plugins">
        {order.length ? (
          order.map((name) => <PluginRow key={name} name={name} />)
        ) : (
          <Row title="None yet" description={how ? `Get one above, put a plugin's folder in ${pluginsFolderPath()}, or run npx ardia-plugin dev in its folder.` : undefined}>
            {how ? null : <Button variant="text" look="link" pad="none" title="How to add one" onPress={() => setHow(true)} />}
          </Row>
        )}
      </Group>
      <RegistriesSection />
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

function originText(listing: PluginListing | undefined, _active: boolean): string | null {
  if (listing?.source === "dev") return listing.shadowsStore ? "Dev (in place of its installed copy)" : "Dev";
  if (listing?.official) return "Official";
  return listing?.manifest?.id ?? null;
}

function statusOf(m: PluginManifest | null, problems: string[], active: boolean, review: boolean, p: ProcessState | undefined, unsaved: boolean, describe = true): string {
  if (!m) return problems.slice(0, 2).join("; ") || "This plugin can't load";
  if (unsaved && !active) return UNSAVED;
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
  const unsaved = usePluginUnsaved(name);
  const m = listing?.manifest ?? null;
  return (
    <Row
      title={m ? `${m.title}${m.version ? ` ${m.version}` : ""}` : name}
      description={[originText(listing, active), m && fullControlLine(m) ? FULL_CONTROL_SUMMARY : null, statusOf(m, listing?.problems ?? [], active, review, process, unsaved)].filter(Boolean).join(" · ")}
      icon={<Symbol name={m?.icon ?? m?.page?.icon ?? "puzzlepiece"} size={14} color={theme.icon} style={ICON} />}
      onPress={() => goToSettingsPane("plugins", null, name)}
    >
      {listing?.source === "dev" ? <DevBadge /> : null}
      {record.pendingUpdate ? <Button title="Update…" onPress={() => reviewUpdate(name)} /> : null}
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
  const perProfile = usePluginListing(name)?.manifest?.scope === "profile";
  const [profileId, setProfileId] = useSettingsProfile();
  const space = perProfile ? profileId : null;
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);
  useEffect(() => {
    let live = true;
    asked.current += 1;
    setDraft("");
    setProblem(null);
    setSaved(null);
    setBusy(false);
    void pluginSecretRowIsSet(name, row.key, space).then((set) => live && setSaved(set));
    return () => {
      live = false;
    };
  }, [name, row.key, space]);
  const write = async (value: string | null) => {
    const mine = ++asked.current;
    setBusy(true);
    const outcome = await setPluginSecretRow(name, row.key, value, space);
    if (mine !== asked.current) return;
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.message);
    setProblem(null);
    setDraft("");
    setSaved(value !== null && value !== "");
  };
  const status = problem ?? (saved === null ? null : saved ? `Saved in ${PLATFORM_TERMS.secretStore}` : "Not set");
  return (
    <Row title={row.title} description={[row.description, status].filter(Boolean).join(" · ") || undefined}>
      {perProfile ? <ProfilePicker value={profileId} onChange={setProfileId} /> : null}
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
  const unsaved = usePluginUnsaved(name);
  const programs = usePluginPrograms(name);
  const values = usePluginValues(name);
  const movesProfiles = useNeverChosenCount();
  const record = usePluginRecord(name);
  const m = listing?.manifest ?? null;
  if (!listing) return <PaneSubPage intro="This plugin isn't installed any more.">{null}</PaneSubPage>;
  return (
    <PaneSubPage intro={m?.description || undefined}>
      <Group>
        <Row
          title={active ? "On" : review ? "Changed since you turned it on" : "Off"}
          description={[originText(listing, active), statusOf(m, listing.problems, active, review, process, unsaved, false)].filter(Boolean).join(" · ") || undefined}
        >
          <Toggle value={active} disabled={!m} asksFirst={!active} accessibilityLabel={`Turn on ${m?.title ?? name}`} onChange={(on) => setOn(name, on)} />
        </Row>
        {record.revoked ? <Row title={record.revoked.action === "block" ? "Blocked by Ardia's registry" : "Turned off by Ardia's registry"} description={record.revoked.reason} /> : null}
        {record.pendingUpdate ? (
          <Row title={`Version ${record.pendingUpdate.version} is ready`} description={record.pendingUpdate.added.length ? `It asks for more: ${record.pendingUpdate.added.slice(0, 3).join("; ")}` : "It needs your review before it switches over."}>
            <Button title="Update…" onPress={() => reviewUpdate(name)} />
          </Row>
        ) : null}
        {record.updated && record.approved === listing.hash ? <Row title={updateNoteText(record.updated).title} description={updateNoteText(record.updated).description} /> : null}
        {active && (m?.process || (m?.main && process)) ? (
          <Row title={m?.process ? "Its program" : "Its code"} description={m?.process ? m.process.run.join(" ") : typeof m?.main === "string" ? m.main : m?.main?.entry}>
            <Button title="Show Log" onPress={() => showPluginLog(name)} />
            <Button title="Restart" onPress={() => restartPlugin(name)} />
          </Row>
        ) : null}
        {active && (m?.main || m?.process) ? <PluginHealthDetails name={name} /> : null}
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
      {m ? <InstallDetails name={name} listing={listing} /> : null}
      {m ? (
        <>
          <SectionHeader title="What it gets" />
          <Group>
            {consentLines(m, { controlOff, official: !!listing.official && !active, movesProfiles, installed: active }).map((line) => (
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
        <Row title="Remove" description={listing.source === "store" ? "Removes its download, its data and its commands on your PATH." : listing.source === "dev" ? "Removes the dev link. Your project stays." : `Moves the plugin to the ${PLATFORM_TERMS.trash}.`}>
          <Button title="Remove…" kind="destructive" onPress={() => void confirmRemove(name, m?.title ?? name)} />
        </Row>
      </Group>
    </PaneSubPage>
  );
}

function DevBadge() {
  const theme = useTheme();
  return (
    <View style={[BADGE, { borderColor: theme.warning }]}>
      <Text size="small" weight="semibold" tone="warning">
        Dev
      </Text>
    </View>
  );
}

function InstallDetails({ name, listing }: { name: string; listing: PluginListing }) {
  const lock = usePluginLockEntry(name);
  const record = usePluginRecord(name);
  const order = useProfileOrder();
  const records = useProfileRecords();
  const profiles = order.flatMap((id) => (records[id] ? [{ id, name: records[id]!.name }] : []));
  const [problem, setProblem] = useState<string | null>(null);
  const m = listing.manifest;
  if (!m) return null;
  const profileScoped = m.scope === "profile";
  const chosen = record.profiles === undefined || record.profiles === "all" ? "all" : "selected";
  return (
    <>
      <SectionHeader title="Install" />
      <Group>
        {lock && lock.source.kind !== "file" ? (
          <Row title="Updates" description={lock.source.kind === "github" ? `From github.com/${lock.source.repo}` : lock.source.url}>
            <PopUp value={lock.channel} options={[{ value: "latest", title: "Stable" }, { value: "beta", title: "Beta" }]} accessibilityLabel="Update channel" onChange={(channel) => void setPluginChannel(name, channel)} />
          </Row>
        ) : null}
        {listing.source === "store" && listing.previousVersion ? (
          <Row title="Earlier version" description={problem ?? `Go back to ${listing.previousVersion}`}>
            <Button title="Roll Back" onPress={() => void rollbackPlugin(name).then((r) => setProblem(r.ok ? null : (r.reason ?? null)))} />
          </Row>
        ) : null}
        {profileScoped && profiles.length > 1 ? (
          <Row title="Profiles" description={chosen === "all" ? "On in every profile" : `On in ${(record.profiles as string[]).length} of ${profiles.length} profiles`}>
            <PopUp
              value={chosen}
              options={[{ value: "all", title: "All Profiles" }, { value: "selected", title: "Selected Profiles" }]}
              accessibilityLabel="Profiles"
              onChange={(v) => void setPluginProfiles(name, v === "all" ? "all" : profiles.slice(0, 1).map((p) => p.id))}
            />
          </Row>
        ) : null}
        {profileScoped && chosen === "selected"
          ? profiles.map((p) => (
              <Row key={p.id} title={p.name}>
                <Toggle
                  value={(record.profiles as string[]).includes(p.id)}
                  accessibilityLabel={`On in ${p.name}`}
                  onChange={(on) => void setPluginProfiles(name, on ? [...(record.profiles as string[]), p.id] : (record.profiles as string[]).filter((id) => id !== p.id))}
                />
              </Row>
            ))
          : null}
      </Group>
    </>
  );
}

const ICON = { width: 18, height: 18 } as const;
const BADGE = { borderRadius: radius.control, borderWidth: 1, paddingHorizontal: space.s, paddingVertical: space.xxs } as const;
