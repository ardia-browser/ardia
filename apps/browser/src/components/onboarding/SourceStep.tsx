import { fileExists, fileIcon } from "../../state/app/system";
import { useEffect, useState } from "react";
import { Image, View, type ImageSourcePropType } from "react-native";
import { IconTile, Text } from "../ui";
import { space } from "../ui/tokens";
import { isWebDemo } from "../../state/onboarding/demoSteps";
import { openImport } from "../../state/settings/settingsWindows";
import { useImportFlow } from "../../state/import/flow";
import { importedFrom, importFailed, importSucceeded, watchImportEnd } from "../../state/onboarding/sourceImport";
import { noteOnboardingImport } from "../../state/telemetry/usage";
import { chooseSource, confirmAnswer, skipStep, sourcePatch, useOnboarding, type BrowserSourceId } from "../../state/onboarding/onboarding";
import { StepActions, StepLayout } from "./StepLayout";
import { SectionLabel, SelectTile, useOnboardingColors } from "./Parts";
import { SourcePreview } from "./SourcePreview";
import { useFlowPreviewShown, useSection } from "./sectionContext";
import { SecondaryButton } from "./Buttons";
import { SetupCodeLink, SetupCodeStep } from "./SetupCodeStep";
import { browserIcon } from "./browserIcons";
import { useImageRing } from "./GlassBacking";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { importModule } from "../../state/import/importApi";
import { sourceTiles, type SourceCandidate, type SourceTile } from "./sourceTiles";

type Tile = SourceTile;

const BY_APP_BUNDLE = PLATFORM_FEATURES.findsBrowsersBy === "appBundle";

const detect = (isFound: (c: SourceCandidate) => boolean) => sourceTiles(isFound, PLATFORM_FEATURES);

const detectByAppBundle = () => detect((c) => BY_APP_BUNDLE && fileExists(c.app));

export function SourceStep() {
  const source = useOnboarding((s) => s.source);
  const redo = useOnboarding((s) => s.redo);
  const redoSource = useOnboarding((s) => s.redoSource);
  const { active } = useSection();
  const [tiles, setTiles] = useState<Tile[]>(detectByAppBundle);
  const [importing, setImporting] = useState<BrowserSourceId | null>(null);
  const [pastingCode, setPastingCode] = useState(false);
  const previewShown = useFlowPreviewShown();

  useEffect(() => {
    if (!BY_APP_BUNDLE) {
      void importModule()
        .listBrowsers()
        .then((list) => {
          const ids = new Set(list.map((b) => b.id));
          setTiles(detect((c) => ids.has(c.importId ?? c.id)));
        })
        .catch(() => {});
      return;
    }
    void Promise.all(tiles.map(async (t) => ({ ...t, icon: t.app ? ((await fileIcon(t.app, 64)) ?? null) : null }))).then(setTiles);
  }, []);

  useEffect(() => {
    if (!active) setPastingCode(false);
  }, [active]);

  useEffect(() => (importing ? watchImportEnd(() => setImporting(null)) : undefined), [importing]);

  const found = tiles.filter((t) => t.found);
  const others = tiles.filter((t) => !t.found);
  const chosen = tiles.find((t) => t.id === source);
  const canImport = !isWebDemo && !!chosen?.found;
  const choose = (id: BrowserSourceId) => chooseSource(id);

  const startImport = () => {
    if (!chosen) return;
    openImport(chosen.importId ?? chosen.id);
    noteOnboardingImport(chosen.id);
    setImporting(chosen.id);
  };

  const skip = () => {
    chooseSource(redo ? redoSource : null);
    skipStep();
  };

  const done = () => confirmAnswer("source", sourcePatch(), chosen ? [`Coming from ${chosen.name}`] : source === "fresh" ? ["Starting fresh"] : []);

  if (pastingCode) return <SetupCodeStep onBack={() => setPastingCode(false)} />;

  return (
    <StepLayout
      title="Where are you coming from?"
      subtitle="Ardia sets itself up the way you're used to."
      actions={
        <>
          <StepActions disabled={!source} onContinue={done} onSkip={skip} />
          {isWebDemo ? null : <SetupCodeLink onPress={() => setPastingCode(true)} />}
        </>
      }
      preview={<SourcePreview tile={chosen ?? null} fresh={source === "fresh"} found={found} canImport={canImport} importing={importing} onImport={startImport} />}
    >
      {found.length ? (
        <View style={{ gap: space.m }}>
          <SectionLabel title={`Found on this ${PLATFORM_TERMS.computer}`} />
          <TileGrid tiles={found} selected={source} onPress={choose} />
        </View>
      ) : null}
      <View style={{ gap: space.m }}>
        <SectionLabel title={found.length ? "Others" : "Browsers"} />
        <TileGrid tiles={others} selected={source} onPress={choose} fresh />
      </View>
      {!previewShown && canImport && chosen ? <CompactImport name={chosen.name} running={importing === chosen.id} onImport={startImport} /> : null}
    </StepLayout>
  );
}

function CompactImport({ name, running, onImport }: { name: string; running: boolean; onImport: () => void }) {
  const colors = useOnboardingColors();
  const succeeded = useImportFlow(importSucceeded);
  const failed = useImportFlow(importFailed);
  const from = useImportFlow(importedFrom);
  return (
    <View style={{ alignItems: "flex-start" }}>
      {running && !failed ? (
        <Text size="small" color={colors.rowSubtitle}>
          {succeeded ? `Imported from ${from ?? name}` : `Importing from ${name}… It runs in its own window.`}
        </Text>
      ) : (
        <SecondaryButton title={`Import from ${name}`} filled onPress={onImport} />
      )}
    </View>
  );
}

function TileGrid({ tiles, selected, onPress, fresh }: { tiles: Tile[]; selected: BrowserSourceId | null; onPress: (id: BrowserSourceId) => void; fresh?: boolean }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.m }} accessibilityRole="radiogroup">
      {tiles.map((t) => (
        <SourceTile key={t.id} title={t.name} icon={browserIcon(t.id, t.icon)} symbol="globe" selected={selected === t.id} onPress={() => onPress(t.id)} />
      ))}
      {fresh ? <SourceTile title="Starting fresh" icon={null} symbol="sparkles" selected={selected === "fresh"} onPress={() => onPress("fresh")} /> : null}
    </View>
  );
}

const SOURCE_TILE = { height: 68, icon: 30 } as const;

function SourceTile({ title, icon, symbol, selected, onPress }: { title: string; icon: ImageSourcePropType | null; symbol: string; selected: boolean; onPress: () => void }) {
  const colors = useOnboardingColors();
  const ring = useImageRing(icon, selected);
  return (
    <SelectTile title={title} height={SOURCE_TILE.height} selected={selected} role="radio" titlePad={space.xs} titleLines={1} ring={ring} onPress={onPress}>
      {() =>
        icon ? (
          <Image source={icon} style={{ width: SOURCE_TILE.icon, height: SOURCE_TILE.icon }} />
        ) : (
          <View style={{ margin: space.xxs }}>
            <IconTile symbol={symbol} size="s" fill={colors.iconContainer} glyph={colors.subtitle} />
          </View>
        )
      }
    </SelectTile>
  );
}
