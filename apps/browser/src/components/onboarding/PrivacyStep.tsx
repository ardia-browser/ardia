import { engineHost } from "@ardia/core";
import { View } from "react-native";
import { searchEngines } from "../../state/settings/settings";
import { useSettings } from "../../state/browser/hooks";
import { isSharing, setSharing } from "../../state/telemetry/client";
import { SHARING_COPY } from "../../state/telemetry/copy";
import { Text } from "../ui";
import { space } from "../ui/tokens";
import { SiteLogo } from "./SiteLogo";
import { Page } from "./LayoutSteps";
import { useScreen } from "./Screen";
import { useSection } from "./sectionContext";
import { setOnboardingDraft, setOnboardingExtras, useOnboarding } from "../../state/onboarding/onboarding";
import { keysOf, useQuestions } from "../../state/onboarding/questions";
import { OptionCard } from "./OptionCard";
import { SelectTile } from "./Parts";
import { useSiteRing } from "./GlassBacking";
import { AnonCard } from "./AnonCard";

const KEYS = keysOf("searchPrivacy");
const ENGINES = ["google", "duckduckgo", "bing", "kagi", "ecosia", "brave", "startpage"];

export function SearchPrivacyStep() {
  const { sub } = useSection();
  const id = useQuestions("searchPrivacy")[sub]?.id;
  const { values } = useScreen(KEYS);
  const setDraft = setOnboardingDraft;
  const redo = useOnboarding((s) => s.redo);
  const share = useOnboarding((s) => s.extras.share) ?? (redo ? isSharing() : true);
  const all = useSettings((st) => searchEngines(st));
  const engines = all.filter((e) => ENGINES.includes(e.id) || e.id === values.searchEngine);

  if (id === "crash")
    return (
      <Page
        id={id}
        title={SHARING_COPY.onboarding.title}
        patch={{}}
        picked={share ? ["Sharing crash reports"] : []}
        onConfirm={() => {
          if (share !== isSharing() || !redo) setSharing(share, redo ? "settings" : "onboarding");
        }}
        preview={<AnonCard on={share} />}
        holdScroll
      >
        <OptionCard control="check" icon="stethoscope" title={SHARING_COPY.toggle} subtitle={SHARING_COPY.onboarding.row} selected={share} onPress={() => setOnboardingExtras({ share: !share })} />
      </Page>
    );
  const engine = all.find((e) => e.id === values.searchEngine);
  return (
    <Page
      id="engine"
      title="Search with what?"
      subtitle="For anything that isn't a website."
      patch={{ searchEngine: values.searchEngine }}
      picked={[`Search with ${engine?.name ?? "your engine"}`]}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.m }} accessibilityRole="radiogroup" accessibilityLabel="Search engine">
        {engines.map((e) => (
          <EngineTile key={e.id} title={e.name} url={`https://${engineHost(e)}`} selected={e.id === values.searchEngine} onPress={() => setDraft({ searchEngine: e.id })} />
        ))}
      </View>
    </Page>
  );
}

function EngineTile({ title, url, selected, onPress }: { title: string; url: string; selected: boolean; onPress: () => void }) {
  const ring = useSiteRing(url, selected);
  return (
    <SelectTile title={title} height={64} selected={selected} role="radio" titleLines={1} ring={ring} onPress={onPress}>
      {() => <SiteLogo url={url} size={18} />}
    </SelectTile>
  );
}
