import { useEffect, useState } from "react";
import { View } from "react-native";
import type { PluginManifest, RowSpec } from "../../../lib/pluginManifest";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import type { PluginListing, ProcessState, ProgramsState } from "../../../state/plugins/store";
import {
  consentLines,
  disablePlugin,
  installOfficialPlugin,
  isAlwaysOn,
  pluginsFolderPath,
  relinkPrograms,
  canRelink,
  removePlugin,
  requestPluginConsent,
  restartPlugin,
  setPluginValue,
  showPluginLog,
  showPluginsFolder,
} from "../../../state/plugins/actions";
import { usePluginActive, usePluginListing, usePluginNeedsReview, usePluginProcess, usePluginPrograms, usePluginRecord, usePluginValues } from "../../../state/plugins/hooks";
import { goToSettingsPane, SETTINGS_WINDOW_ID, type SettingsPlace } from "../../../state/settings/settingsWindows";
import { confirm } from "../../../state/app/system";
import { Button, PopUp, Symbol, TextField, Toggle } from "../../ui";
import { Group, Row, SectionHeader } from "../Form";
import { useTheme } from "../../ui/theme";
import { PaneSubPage } from "./PaneSubPage";
import { releaseOrphanedConsent } from "../../../state/plugins/consentSurface";
import { OfficialPluginsSection, usePluginsBelowOfficial } from "./OfficialPlugins";

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

function processText(p: ProcessState | undefined): string | null {
  if (!p) return null;
  if (p.state === "running") return "Running";
  if (p.state === "starting") return "Starting…";
  if (p.state === "waiting") return `Restarting after ${p.failures === 1 ? "a crash" : `${p.failures} crashes`}…`;
  if (p.state === "crashed") return `Its program crashed (${p.reason}) and was stopped`;
  if (p.state === "failed") return `Its program couldn't start: ${p.reason}`;
  return "Its program finished";
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
  const builtIn = isAlwaysOn(listing) ? (active ? "Built in, installed" : "Built in, not installed") : "Built in";
  if (listing?.ignoresUserFolder) return `${builtIn} (the folder of the same name in ${pluginsFolderPath()} is ignored)`;
  if (listing?.bundled) return builtIn;
  return listing?.replacesBundled ? "Replaces the built-in plugin" : null;
}

function statusOf(m: PluginManifest | null, problems: string[], active: boolean, review: boolean, p: ProcessState | undefined): string {
  if (!m) return problems.slice(0, 2).join("; ") || "This plugin can't load";
  if (review) return "Its plugin.json changed. Review it to turn it back on.";
  const running = active ? processText(p) : null;
  return [m.description, running].filter(Boolean).join(" · ");
}

function setOn(name: string, on: boolean) {
  if (on) {
    releaseOrphanedConsent();
    requestPluginConsent(name);
  }
  else disablePlugin(name);
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
      icon={<Symbol name={m?.page?.icon ?? "puzzlepiece"} size={14} color={theme.icon} style={ICON} />}
      onPress={() => goToSettingsPane("plugins", null, name)}
    >
      {isAlwaysOn(listing) ? (
        active ? null : <Button title="Install…" onPress={() => void installOfficialPlugin(name, { showSheet: false })} />
      ) : (
        <Toggle value={active} disabled={!m} accessibilityLabel={`Turn on ${m?.title ?? name}`} onChange={(on) => setOn(name, on || (record.enabled && review))} />
      )}
    </Row>
  );
}

function ValueRow({ name, row, value }: { name: string; row: RowSpec; value: string | boolean }) {
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  useEffect(() => setDraft(typeof value === "string" ? value : ""), [value]);
  if (row.type === "toggle") return <Row title={row.title} description={row.description}><Toggle value={value === true} accessibilityLabel={row.title} onChange={(on) => setPluginValue(name, row.key, on)} /></Row>;
  if (row.type === "choice")
    return (
      <Row title={row.title} description={row.description}>
        <PopUp value={String(value)} options={row.choices.map((c) => ({ value: c.value, title: c.title }))} accessibilityLabel={row.title} onChange={(v) => setPluginValue(name, row.key, v)} />
      </Row>
    );
  return (
    <Row title={row.title} description={row.description}>
      <TextField value={draft} width={200} onChangeText={setDraft} onSubmit={() => setPluginValue(name, row.key, draft)} onBlur={() => setPluginValue(name, row.key, draft)} />
    </Row>
  );
}

async function confirmRemove(name: string, title: string) {
  const ok = await confirm({ title: `Remove ${title}?`, message: `Its folder moves to the ${PLATFORM_TERMS.trash}, and its data and its panel's website data are deleted.`, confirmTitle: "Remove", destructive: true, windowId: SETTINGS_WINDOW_ID });
  if (!ok) return;
  const removed = await removePlugin(name);
  if (removed.ok || removed.removed) goToSettingsPane("plugins");
}

function PluginPage({ name }: { name: string }) {
  const theme = useTheme();
  const listing = usePluginListing(name);
  const active = usePluginActive(name);
  const review = usePluginNeedsReview(name);
  const process = usePluginProcess(name);
  const programs = usePluginPrograms(name);
  const values = usePluginValues(name);
  const m = listing?.manifest ?? null;
  if (!listing) return <PaneSubPage intro="This plugin isn't installed any more.">{null}</PaneSubPage>;
  return (
    <PaneSubPage intro={m?.description || undefined}>
      <SectionHeader title={m?.title ?? name} />
      <Group>
        <Row
          title={isAlwaysOn(listing) ? (active ? "Installed" : "Not installed") : active ? "On" : review ? "Changed since you turned it on" : "Off"}
          description={[originText(listing, active), statusOf(m, listing.problems, active, review, process)].filter(Boolean).join(" · ")}
        >
          {isAlwaysOn(listing) ? (
            active ? null : <Button title="Install…" onPress={() => void installOfficialPlugin(name, { showSheet: false })} />
          ) : (
            <Toggle value={active} disabled={!m} accessibilityLabel={`Turn on ${m?.title ?? name}`} onChange={(on) => setOn(name, on)} />
          )}
        </Row>
        {m?.process && active ? (
          <Row title="Its program" description={m.process.run.join(" ")}>
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
      {m ? (
        <>
          <SectionHeader title="What it gets" />
          <Group>
            {consentLines(m).map((line) => (
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
      {listing.bundled ? null : (
        <Group>
          <Row title="Remove" description={`Moves the plugin to the ${PLATFORM_TERMS.trash}.`}>
            <Button title="Remove…" kind="destructive" onPress={() => void confirmRemove(name, m?.title ?? name)} />
          </Row>
        </Group>
      )}
    </PaneSubPage>
  );
}

const LINE = { flex: 1 } as const;
const ICON = { width: 18, height: 18 } as const;
const TITLE_ICON = { width: 28, height: 28 } as const;
