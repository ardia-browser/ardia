import { useState } from "react";
import { View } from "react-native";
import { CLI_PLUGIN, describeCliInstall, installCliInBackground, useCli } from "../../../state/app/cliControl";
import { usePluginActive, usePluginListing, usePluginPrograms } from "../../../state/plugins/hooks";
import { canRelink, relinkPrograms } from "../../../state/plugins/actions";
import type { PluginListing, ProgramsState } from "../../../state/plugins/store";
import { goToSettingsPane, type SettingsPlace } from "../../../state/settings/settingsWindows";
import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import { systemInfo } from "../../../platform/app";
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


function pluginCommandLine(plugin: PluginListing | undefined, programs: ProgramsState | undefined, installed: boolean): string {
  if (!plugin?.manifest) return "Not in this build.";
  if (!installed) return "Not installed.";
  if (programs?.state === "linked") return programs.linked.includes("ardia") ? "On your PATH. It can control Ardia." : Object.values(programs.refused).join("; ");
  if (programs?.state === "failed") return `Not on your PATH: ${programs.reason}`;
  return "Putting it on your PATH…";
}

function PluginCommandRow() {
  const cli = useCli();
  const plugin = usePluginListing(CLI_PLUGIN);
  const programs = usePluginPrograms(CLI_PLUGIN);
  const installed = usePluginActive(CLI_PLUGIN);
  const failed = canRelink(programs);
  return (
    <Row
      anchor="advanced.ardiaCommand"
      description={
        <View>
          <Text selectable size="caption" tone={failed ? "destructive" : "textSecondary"} style={NOTE()}>
            {pluginCommandLine(plugin, programs, installed)}
          </Text>
          {cli.server?.state === "external" ? (
            <Text size="caption" tone="textSecondary" style={NOTE()}>
              This instance has its own DevTools port.
            </Text>
          ) : null}
          {plugin?.manifest && !installed ? <Button variant="text" look="link" pad="none" title="Open Plugins" onPress={() => goToSettingsPane("plugins")} /> : null}
        </View>
      }
    >
      {failed ? <Button title="Try Again" onPress={() => relinkPrograms(CLI_PLUGIN)} /> : null}
    </Row>
  );
}

function CommandLineSection() {
  const personal = PLATFORM_FEATURES.plugins && systemInfo().bundleId === "dev.simon.ardia.personal";
  const viaPlugin = PLATFORM_FEATURES.plugins && !personal;
  const on = useSettings((s) => s.cliControl);
  const cli = useCli();
  const ruleRows = useAutomationRuleRows();
  const server = cli.server;
  const serverNote =
    server?.state === "external"
      ? "This instance already has a DevTools port from the command line, so the setting leaves it alone."
      : server?.reason
        ? server.reason
        : on && server?.state === "on"
          ? server.connections
            ? `Connected now: ${server.connections === 1 ? "1 session" : `${server.connections} sessions`}.`
            : "On. Nothing is connected."
          : personal ? "Lets ardia-personal control this browser. It stays on after you quit."
          : "Installs the ardia command and lets it open, read and act in every page you're signed in to. It stays on after you quit.";
  const failed = !!cli.error && !cli.installing;
  const setOn = (next: boolean) => {
    updateSettings({ cliControl: next });
    if (!personal && next && !cli.installing && (!cli.installedVersion || cli.error)) void installCliInBackground("settings");
  };
  const tryAgain = () => void installCliInBackground("settings");
  const installLine = !personal && (on || cli.installedVersion || cli.installing || failed) ? describeCliInstall(cli) : null;
  return (
    <>
      <SectionHeader title="Command line and automation" />
      <Group>
        {viaPlugin ? <PluginCommandRow /> : (
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
          {on && !failed && cli.installedVersion && !cli.installing ? <Button title="Reinstall" onPress={() => void installCliInBackground("settings")} /> : null}
          <Toggle value={on} accessibilityLabel={personal ? "ardia-personal command" : "ardia command"} onChange={setOn} />
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
