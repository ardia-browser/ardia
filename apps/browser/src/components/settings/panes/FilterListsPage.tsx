import { View } from "react-native";
import { setContentBlockerAllowed } from "../../../state/site/siteSettings";
import { Button, space, Text } from "../../ui";
import { Favicon } from "../../favicon/Favicon";
import { Group, Row, SectionHeader } from "../Form";
import { setting } from "../settingsIndex";
import { blockerVersionNote, FilterLists, useContentBlocker } from "./FilterListsSheet";
import { HiddenElementsSection } from "./HiddenElementsSection";
import { UI_LOCALE } from "../../../lib/uiLocale";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PaneSubPage } from "./PaneSubPage";

export function FilterListsPage() {
  return (
    <PaneSubPage intro={setting("general.filterLists").description}>
      {PLATFORM_FEATURES.contentBlocker ? <FilterListsContent /> : null}
    </PaneSubPage>
  );
}

function FilterListsContent() {
  const [blocker, refresh, unavailable] = useContentBlocker();
  return (
    <View>
      {unavailable && (
        <>
          <SectionHeader title="uBlock Origin" />
          <Group>
            <Row title="uBlock Origin isn't answering" description="Its settings show here once it responds. Pages keep the blocking they had.">
              <Button title="Try Again" onPress={refresh} />
            </Row>
          </Group>
        </>
      )}
      <FilterLists blocker={blocker} refresh={refresh} />
      {!!blocker?.allowedHosts.length && (
        <>
          <SectionHeader title="Sites without blocking" description="Turned off from a site's controls. Blocking applies to subdomains too." />
          <Group>
            {blocker.allowedHosts.map((host) => (
              <Row key={host} icon={<Favicon url={`https://${host}`} />} title={host}>
                <Button title="Block Again" onPress={() => void setContentBlockerAllowed(host, false).then(refresh)} />
              </Row>
            ))}
          </Group>
        </>
      )}
      <HiddenElementsSection />
      {blocker && (
        <Text size="caption" tone="textTertiary" style={FOOTNOTE}>
          {`${(blocker.stats.networkFilters ?? 0).toLocaleString(UI_LOCALE)} network and ${(blocker.stats.cosmeticFilters ?? 0).toLocaleString(UI_LOCALE)} cosmetic rules loaded. ${blockerVersionNote(blocker)}`}
        </Text>
      )}
    </View>
  );
}

const FOOTNOTE = { marginTop: space.xl } as const;
