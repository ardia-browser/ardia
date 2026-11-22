import { useState } from "react";
import { View } from "react-native";
import { describeCommandInstall, installCommandInBackground, useCommandInstall } from "../../../state/app/linuxCommandInstall";
import { useControlServer } from "../../../state/app/programControl";
import { programControlOn, setControlFromSettings, setProgramControl } from "../../../state/app/programControlSetting";
import { usePluginsWithPrograms, usePluginPrograms } from "../../../state/plugins/hooks";
import { useProgramRegistry } from "../../../state/plugins/programRegistry";
import { canRelink, relinkPrograms } from "../../../state/plugins/actions";
import type { ProgramsState } from "../../../state/plugins/store";
import { goToSettingsPane, type SettingsPlace } from "../../../state/settings/settingsWindows";
import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import { openChromeSettings } from "../../../state/pages/urls";
import type { BatterySaverWhen, Settings } from "../../../state/settings/settings";
import { keepSiteActive, stopKeepingSiteActive, type MemorySaverMode } from "../../../state/tabs/memorySaver";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { Button, DialogActions, DialogTitle, lineHeight, PopUp, Sheet, space, Text, TextField, Toggle } from "../../ui";
import { perLook } from "../../ui/tokens";
import { Favicon } from "../../favicon/Favicon";
import { FormField, Group, Row, SectionHeader, SettingToggle } from "../Form";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { useAutomationRuleRows } from "./AutomationRules";
import { WebEngineSection } from "./WebEngineSection";

const BATTERY_SAVER_DESCRIPTIONS: Record<BatterySaverWhen, string> = {
  lowBattery: `At 20% battery or less, or in ${PLATFORM_TERMS.lowPowerMode}, busy background tabs pause and animations slow down.`,
  unplugged: `On battery or in ${PLATFORM_TERMS.lowPowerMode}, busy background tabs pause and animations slow down.`,
  never: "Background tabs and animations run at full speed on battery.",
};

type MemorySaverLevel = "off" | MemorySaverMode | "custom";
type MemorySaverKeys = Pick<Settings, "memorySaver" | "memorySaverMode" | "loadProfilesWhenOpened" | "unloadProfilesAfter">;

const profilesUnload = (after: string) => (PLATFORM_FEATURES.unloadsIdleProfiles ? ` Profiles you aren't using unload after ${after}.` : "");

type MemorySaverPreset = Exclude<MemorySaverLevel, "custom">;

const MEMORY_SAVER_LEVELS: Record<MemorySaverPreset, { title: string; description: () => string; settings: Partial<MemorySaverKeys> }> = {
  off: {
    title: "Off",
    description: () => "Tabs stay loaded.",
    settings: { memorySaver: false },
  },
  moderate: {
    title: "Moderate",
    description: () => "Tabs become inactive after a longer period of time. Profiles load when you first open them.",
    settings: { memorySaver: true, memorySaverMode: "moderate", loadProfilesWhenOpened: true, unloadProfilesAfter: "never" },
  },
  balanced: {
    title: "Balanced (recommended)",
    description: () => "Tabs become inactive after an optimal period of time. Profiles load when you first open them.",
    settings: { memorySaver: true, memorySaverMode: "balanced", loadProfilesWhenOpened: true, unloadProfilesAfter: "never" },
  },
  maximum: {
    title: "Maximum",
    description: () => `Tabs become inactive after a shorter period of time. Profiles load when you first open them.${profilesUnload("15 minutes")}`,
    settings: { memorySaver: true, memorySaverMode: "maximum", loadProfilesWhenOpened: true, unloadProfilesAfter: "15m" },
  },
};
const MEMORY_SAVER_PRESETS = Object.keys(MEMORY_SAVER_LEVELS) as MemorySaverPreset[];

const UNLOAD_AFTER: Record<Settings["unloadProfilesAfter"], string> = { never: "", "5m": "5 minutes", "15m": "15 minutes", "1h": "an hour", "2h": "2 hours" };

function memorySaverLevel(s: MemorySaverKeys): MemorySaverLevel {
  if (!s.memorySaver) return "off";
  const preset = MEMORY_SAVER_LEVELS[s.memorySaverMode].settings;
  return s.loadProfilesWhenOpened === preset.loadProfilesWhenOpened && s.unloadProfilesAfter === preset.unloadProfilesAfter ? s.memorySaverMode : "custom";
}

function customDescription(s: MemorySaverKeys) {
  const tabs = MEMORY_SAVER_LEVELS[s.memorySaverMode].description().split(". ")[0];
  const load = s.loadProfilesWhenOpened ? " Profiles load when you first open them." : " Every profile loads when Ardia opens.";
  return `${tabs}.${load}${s.unloadProfilesAfter === "never" ? "" : profilesUnload(UNLOAD_AFTER[s.unloadProfilesAfter])} Pick a level to use its settings instead.`;
}

export function AdvancedPane(_: SettingsPlace) {
  return (
    <View>
      <SectionHeader title="Browsing" />
      <Group>
        <SettingToggle anchor="advanced.showFullUrl" />
        <Row anchor="advanced.chromeSettings">
          <Button title="Open Chromium Settings" onPress={openChromeSettings} />
        </Row>
      </Group>
      <PerformanceSection />
      {PLATFORM_FEATURES.webKit && <WebEngineSection />}
      <CommandLineSection />
    </View>
  );
}

function PerformanceSection() {
  const memorySaver = useSettings((s) => s.memorySaver);
  const memorySaverMode = useSettings((s) => s.memorySaverMode);
  const loadProfilesWhenOpened = useSettings((s) => s.loadProfilesWhenOpened);
  const unloadProfilesAfter = useSettings((s) => s.unloadProfilesAfter);
  const keys = { memorySaver, memorySaverMode, loadProfilesWhenOpened, unloadProfilesAfter };
  const batterySaverWhen = useSettings((s) => s.batterySaverWhen);
  const keepActiveSites = useSettings((s) => s.keepActiveSites);
  const level = memorySaverLevel(keys);
  const options = [...MEMORY_SAVER_PRESETS.map((value) => ({ value: value as MemorySaverLevel, title: MEMORY_SAVER_LEVELS[value].title })), ...(level === "custom" ? [{ value: "custom" as const, title: "Custom" }] : [])];
  return (
    <>
      <SectionHeader title="Performance" />
      <Group>
        <Row anchor="advanced.memorySaver" description={level === "custom" ? customDescription(keys) : MEMORY_SAVER_LEVELS[level].description()}>
          <PopUp value={level} options={options} onChange={(v) => v !== "custom" && updateSettings(MEMORY_SAVER_LEVELS[v].settings)} minWidth={190} />
        </Row>
        <Row anchor="advanced.keepActiveSites">
          <Button title="Add Site…" icon="plus" onPress={() => showSettingsSheet(<KeepActiveSiteSheet />)} />
        </Row>
        {memorySaver &&
          [...keepActiveSites]
            .sort((a, b) => a.localeCompare(b))
            .map((site) => (
              <Row key={site} icon={<Favicon url={siteUrl(site)} />} title={site}>
                <Button variant="icon" icon="trash" size="m" onPress={() => stopKeepingSiteActive(site)} tooltip="Remove" />
              </Row>
            ))}
        <Row anchor="advanced.batterySaver" description={BATTERY_SAVER_DESCRIPTIONS[batterySaverWhen]}>
          <PopUp
            value={batterySaverWhen}
            options={[
              { value: "lowBattery", title: "When battery is low" },
              { value: "unplugged", title: "When unplugged" },
              { value: "never", title: "Never" },
            ]}
            onChange={(v) => updateSettings({ batterySaverWhen: v })}
            minWidth={190}
          />
        </Row>
      </Group>
    </>
  );
}

const viaPlugin = PLATFORM_FEATURES.plugins;

export function programsLine(programs: ProgramsState | undefined): string {
  if (programs?.state === "linked") {
    const refused = Object.entries(programs.refused).map(([name, reason]) => `${name}: ${reason}`);
    if (refused.length) return refused.join("; ");
    if (programs.adoption === "retrying") return "Waiting for the old install to finish updating…";
    if (programs.adoption === "busy") return "The old install is busy updating. Try again in a moment.";
    if (programs.adoption === "failed") return "The old install couldn't be switched over to it.";
    return programs.linked.length ? `On your PATH: ${programs.linked.join(", ")}` : "Nothing on your PATH.";
  }
  if (programs?.state === "failed") return `Not on your PATH: ${programs.reason}`;
  return "Putting it on your PATH…";
}

function PluginProgramsRow({ name, title }: { name: string; title: string }) {
  const programs = usePluginPrograms(name);
  const failed = canRelink(programs);
  return (
    <Row
      title={title}
      onPress={() => goToSettingsPane("plugins", null, name)}
      description={
        <Text selectable size="caption" tone={failed ? "destructive" : "textSecondary"} style={NOTE()}>
          {programsLine(programs)}
        </Text>
      }
    >
      {failed ? <Button title="Try Again" onPress={() => relinkPrograms(name)} /> : null}
    </Row>
  );
}

function ProgramControlRow() {
  const on = useSettings((settings) => programControlOn({ settings }));
  const server = useControlServer((s) => s.server);
  const note =
    server?.state === "external"
      ? "This instance already has a DevTools port from the command line, so the setting leaves it alone."
      : server?.reason
        ? server.reason
        : on && server?.state === "on"
          ? server.connections
            ? `Connected now: ${server.connections === 1 ? "1 session" : `${server.connections} sessions`}.`
            : "On. Nothing is connected."
          : null;
  return (
    <Row anchor="advanced.programControl" description={note ?? undefined}>
      <Toggle value={on} accessibilityLabel="Let programs control Ardia" onChange={setControlFromSettings} />
    </Row>
  );
}

function ProgramsRows() {
  const plugins = usePluginsWithPrograms();
  const registryUnreadable = useProgramRegistry((s) => s.failClosed);
  return (
    <>
      <ProgramControlRow />
      <Row
        anchor="advanced.programs"
        description={
          <View>
            <Text size="caption" tone="textSecondary" style={NOTE()}>
              {plugins.length ? "Commands your plugins put in your terminal." : "None of your plugins add commands to your terminal."}
            </Text>
            {registryUnreadable ? (
              <Text selectable size="caption" tone="destructive" style={NOTE()}>
                Ardia's list of program names kept for its built-in plugins is missing or damaged, so no program goes on PATH. Reinstall Ardia from ardia.dev.
              </Text>
            ) : null}
          </View>
        }
      />
      {plugins.map((p) => (
        <PluginProgramsRow key={p.name} name={p.name} title={p.title} />
      ))}
    </>
  );
}

function CommandLineSection() {
  const on = useSettings((settings) => programControlOn({ settings }));
  const install = useCommandInstall();
  const server = useControlServer((s) => s.server);
  const ruleRows = useAutomationRuleRows();
  const serverNote =
    server?.state === "external"
      ? "This instance already has a DevTools port from the command line, so the setting leaves it alone."
      : server?.reason
        ? server.reason
        : on && server?.state === "on"
          ? server.connections
            ? `Connected now: ${server.connections === 1 ? "1 session" : `${server.connections} sessions`}.`
            : "On. Nothing is connected."
          : "Installs the ardia command and lets it open, read and act in every page you're signed in to. It stays on after you quit.";
  const failed = !!install.error && !install.installing;
  const setOn = (next: boolean) => {
    setProgramControl(next);
    if (next && !install.installing && (!install.installedVersion || install.error)) void installCommandInBackground("settings");
  };
  const tryAgain = () => void installCommandInBackground("settings");
  const installLine = on || install.installedVersion || install.installing || failed ? describeCommandInstall(install) : null;
  return (
    <>
      <SectionHeader title="Command line and automation" />
      <Group>
        {viaPlugin ? <ProgramsRows /> : (
        <Row
          anchor="advanced.ardiaCommand"
          description={
            <View>
              <Text size="caption" tone="textSecondary" style={NOTE()}>
                {serverNote}
              </Text>
              {installLine ? (
                <Text selectable size="caption" tone={failed ? "destructive" : "textSecondary"} style={NOTE()}>
                  {installLine}
                </Text>
              ) : null}
            </View>
          }
        >
          {failed && on ? <Button title="Try Again" onPress={tryAgain} /> : null}
          {on && !failed && install.installedVersion && !install.installing ? <Button title="Reinstall" onPress={() => void installCommandInBackground("settings")} /> : null}
          <Toggle value={on} accessibilityLabel="ardia command" onChange={setOn} />
        </Row>
        )}
        <SettingToggle anchor="advanced.compactCliPill" />
        {ruleRows}
      </Group>
    </>
  );
}

const siteUrl = (site: string) => (/^[a-z][\w+.-]*:\/\//i.test(site) ? site : `https://${site.replace(/^\[\*\.\]|^\*\.|^\./, "")}`);

function KeepActiveSiteSheet() {
  const [site, setSite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const add = async () => {
    setSaving(true);
    const problem = await keepSiteActive(site);
    setSaving(false);
    if (problem) return setError(problem);
    closeSettingsSheet();
  };
  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle subtitle="Sites you add will always stay active and memory won't be freed up from them.">Add Site</DialogTitle>
      <FormField label="Site">
        <TextField value={site} onChangeText={setSite} placeholder="youtube.com" onSubmit={() => void add()} onEscape={closeSettingsSheet} autoFocus />
      </FormField>
      {error && (
        <Text size="caption" tone="destructive" style={ERROR}>
          {error}
        </Text>
      )}
      <DialogActions>
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title="Add" kind="primary" disabled={saving || !site.trim()} onPress={() => void add()} />
      </DialogActions>
    </Sheet>
  );
}

const NOTE = perLook(() => ({ marginTop: space.xxs, lineHeight: lineHeight.caption }) as const);
const ERROR = { marginTop: space.ml } as const;
