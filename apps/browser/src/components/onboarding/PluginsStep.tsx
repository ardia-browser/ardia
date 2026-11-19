import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { consentLines, dismissPluginConsent, type OfficialPlugin } from "../../state/plugins/actions";
import { useOfficialPlugins, usePluginConsent, usePluginListing, usePluginPrograms } from "../../state/plugins/hooks";
import { usePlugins } from "../../state/plugins/store";
import { CLOSED_GATE, consentPressCounts, consentPressStarted, consentShown } from "../../state/onboarding/consentGate";
import { isOffered, officialTitle, officialView } from "../../state/plugins/officialView";
import { offeredInOnboarding, pluginsCatalogueKnown } from "../../state/onboarding/pluginsOffer";
import { confirmPluginConsent, finishPluginsStep, installPickedPlugins, isPicked, leavePluginsStep, notePluginsShown, passEmptyPluginsStep, primaryTitle, installPluginAgain, skipPluginsStep, togglePluginPick, usePluginsStep } from "../../state/onboarding/pluginsStep";
import { ActivitySpinner, Checkbox, IconTile, Symbol, Text } from "../ui";
import { monoFace, radius, space } from "../ui/tokens";
import { PrimaryButton, SecondaryButton, type PressGate } from "./Buttons";
import { ChoiceCard } from "./ChoiceCard";
import { OptionCard } from "./OptionCard";
import { Tag, useOnboardingColors } from "./Parts";
import { StepActions, StepLayout } from "./StepLayout";

export function PluginsStep() {
  const plugins = offeredInOnboarding(useOfficialPlugins());
  const phase = usePluginsStep((s) => s.phase);
  const picks = usePluginsStep((s) => s.picks);
  const current = usePluginsStep((s) => s.current);
  const consent = usePluginConsent();
  const asking = phase === "working" && !!current && consent?.name === current ? consent : null;
  const known = usePlugins(() => pluginsCatalogueKnown());
  const names = plugins.filter(isOffered).map((p) => p.name).join(" ");
  useEffect(() => {
    notePluginsShown(names ? names.split(" ") : []);
  }, [names]);
  useEffect(() => {
    if (known) passEmptyPluginsStep();
  }, [known, names]);
  useEffect(() => leavePluginsStep, []);
  const nothingToDo = known && phase === "offer" && !plugins.some((p) => p.state === "available");
  const subject = plugins.find((p) => p.name === current) ?? plugins[0];

  if (asking && subject) return <ConsentPage plugin={subject} hash={asking.hash} />;
  return (
    <StepLayout
      pageKey="plugins"
      title={nothingToDo ? "You're already set" : phase === "installed" ? "Installed" : "Want the extras?"}
      subtitle={nothingToDo ? "Nothing to install." : phase === "installed" ? "Open a new terminal to use it." : "Official plugins. Optional."}
      actions={
        <StepActions
          continueTitle={primaryTitle(plugins, { picks, phase })}
          disabled={phase === "working" || !known}
          onContinue={() => (phase === "offer" ? void installPickedPlugins(plugins) : finishPluginsStep(plugins))}
          onSkip={phase === "installed" || nothingToDo ? undefined : () => skipPluginsStep(plugins)}
        />
      }
      preview={<Terminal plugin={subject} />}
    >
      <View style={{ gap: space.m }}>
        {plugins.map((plugin) => (
          <PluginCard key={plugin.name} plugin={plugin} picked={isPicked(plugin, picks)} />
        ))}
      </View>
    </StepLayout>
  );
}

function PluginCard({ plugin, picked }: { plugin: OfficialPlugin; picked: boolean }) {
  const phase = usePluginsStep((s) => s.phase);
  const working = usePluginsStep((s) => s.phase === "working" && s.current === plugin.name);
  const failure = usePluginsStep((s) => s.failures[plugin.name]);
  const programs = usePluginPrograms(plugin.name);
  const view = officialView(plugin, programs, failure ? { state: "failed", reason: failure } : working ? { state: "installing" } : null);
  if (plugin.state === "available" && phase === "offer")
    return <OptionCard control="check" icon={plugin.icon} title={officialTitle(plugin)} subtitle={plugin.blurb} subtitleLines={1} selected={picked} onPress={() => togglePluginPick(plugin)} />;
  return <StatusCard plugin={plugin} status={view.note === "comingSoon" ? "" : (view.status ?? (view.note === "installed" ? "Installed" : null))} failed={view.failed} busy={view.busy} soon={view.note === "comingSoon"} done={view.note === "installed" && !view.failed && !view.busy} />;
}

function StatusCard({ plugin, status, failed, busy, soon, done }: { plugin: OfficialPlugin; status: string | null; failed: boolean; busy: boolean; soon: boolean; done: boolean }) {
  const colors = useOnboardingColors();
  const phase = usePluginsStep((s) => s.phase);
  return (
    <ChoiceCard radius={radius.panel} raised={false} style={{ paddingVertical: space.m, paddingHorizontal: space.l, gap: space.m, opacity: soon ? SOON_OPACITY : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.l }}>
        <IconTile symbol={plugin.icon} size="m" fill={colors.iconContainer} glyph={colors.title} />
        <View style={{ flex: 1, gap: space.xxs }}>
          <Text weight="medium" color={colors.title}>
            {officialTitle(plugin)}
          </Text>
          {status === "" ? null : (
            <Text size="small" lines={failed ? undefined : 1} selectable={failed} color={colors.rowSubtitle}>
              {status ?? plugin.blurb}
            </Text>
          )}
        </View>
        {soon ? <Tag title="Coming soon" /> : null}
        {busy ? <ActivitySpinner style={SPINNER} /> : null}
        {done ? (
          <View pointerEvents="none">
            <Checkbox look="ring" size="m" value />
          </View>
        ) : null}
        {failed ? <Symbol name="exclamationmark.triangle" size={14} color={colors.title} style={WARNING} /> : null}
      </View>
      {failed && phase === "failed" ? (
        <View style={{ flexDirection: "row" }}>
          <SecondaryButton title="Try Again" onPress={() => void installPluginAgain(plugin.name)} />
        </View>
      ) : null}
    </ChoiceCard>
  );
}

function useConsentGate(): { gate: PressGate; shown: () => void } {
  const state = useRef(CLOSED_GATE);
  const [api] = useState(() => ({
    gate: {
      started: () => {
        state.current = consentPressStarted(state.current, performance.now());
      },
      counts: () => consentPressCounts(state.current),
    },
    shown: () => {
      state.current = consentShown(state.current, performance.now());
    },
  }));
  return api;
}

function ConsentPage({ plugin, hash }: { plugin: OfficialPlugin; hash: string }) {
  const colors = useOnboardingColors();
  const { gate, shown } = useConsentGate();
  const listing = usePluginListing(plugin.name);
  const manifest = listing?.manifest;
  const changed = !manifest || listing?.hash !== hash;
  return (
    <StepLayout
      pageKey="plugins-consent"
      onRevealed={shown}
      title={`Install ${officialTitle(plugin)}?`}
      subtitle={plugin.blurb}
      actions={
        <>
          <PrimaryButton title="Install" disabled={changed} gate={gate} onPress={() => void confirmPluginConsent(plugin.name, hash)} />
          <SecondaryButton title="Cancel" onPress={() => void dismissPluginConsent(plugin.name)} />
        </>
      }
      preview={<Terminal plugin={plugin} />}
    >
      <ChoiceCard radius={radius.panel} raised={false} style={{ paddingVertical: space.l, paddingHorizontal: space.l, gap: space.ml }}>
        {changed ? (
          <Text size="small" color={colors.rowSubtitle}>
            The plugin changed while this was open. Cancel and try again.
          </Text>
        ) : (
          consentLines(manifest).map((line) => (
            <View key={line.text} style={{ flexDirection: "row", gap: space.m }}>
              <Symbol name={line.icon} size={12} color={colors.title} style={LINE_ICON} />
              <Text size="small" color={colors.title} style={{ flex: 1 }}>
                {line.text}
              </Text>
            </View>
          ))
        )}
      </ChoiceCard>
    </StepLayout>
  );
}

const TERMINAL_WIDTH = 320;
const DOT = 9;

function Terminal({ plugin }: { plugin: OfficialPlugin | undefined }) {
  const colors = useOnboardingColors();
  const mono = monoFace();
  const programs = usePluginPrograms(plugin?.name ?? "");
  const command = programs?.state === "linked" ? programs.linked[0] : undefined;
  const lines = command ? [`$ ${command} --version`, `${command}${plugin?.version ? ` ${plugin.version}` : ""}`, `$ ${command} tabs`] : ["$ ardia tabs"];
  return (
    <View style={{ width: TERMINAL_WIDTH, borderRadius: radius.panel, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.rowBorder, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", gap: space.s, paddingHorizontal: space.l, paddingVertical: space.ml, borderBottomWidth: 1, borderColor: colors.rowBorder }}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: colors.progressTrack }} />
        ))}
      </View>
      <View style={{ padding: space.l, gap: space.s, minHeight: 96 }}>
        {lines.map((line) => (
          <Text key={line} size="small" color={line.startsWith("$") ? colors.title : colors.subtitle} style={mono}>
            {line}
          </Text>
        ))}
      </View>
    </View>
  );
}

const SOON_OPACITY = 0.6;
const SPINNER = { width: 16, height: 16 } as const;
const WARNING = { width: 18, height: 18 } as const;
const LINE_ICON = { width: 16, height: 16 } as const;
