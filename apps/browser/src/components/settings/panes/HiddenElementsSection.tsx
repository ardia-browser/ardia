import { useEffect, useState } from "react";
import { Button } from "../../ui";
import { Favicon } from "../../favicon/Favicon";
import { Group, ProfilePicker, Row, SectionHeader, useSettingsProfile } from "../Form";
import { useProfiles } from "../../../state/browser/hooks";
import { currentEngineProfile } from "../../../state/browser/current";
import { hiddenElementTitle, profileHiddenElements, restoreHiddenElements, useHiddenElements, type HiddenElement } from "../../../state/site/hiddenElements";

const SHOWN_TITLES = 3;

export function HiddenElementsSection() {
  const [selected, setSelected] = useSettingsProfile();
  const profile = currentEngineProfile(selected);
  const changes = useHiddenElements((s) => s.changes);
  const severalProfiles = useProfiles().length > 1;
  const [loaded, setLoaded] = useState<{ profile: string; elements: HiddenElement[] } | null>(null);
  useEffect(() => {
    let live = true;
    void profileHiddenElements(profile)
      .catch((): HiddenElement[] => [])
      .then((found) => live && setLoaded({ profile, elements: found }));
    return () => {
      live = false;
    };
  }, [profile, changes]);
  const byHost = new Map<string, HiddenElement[]>();
  for (const e of loaded?.elements ?? []) byHost.set(e.host, [...(byHost.get(e.host) ?? []), e]);
  const hosts = [...byHost.keys()].sort();
  if (!hosts.length && !severalProfiles) return null;
  return (
    <>
      <SectionHeader
        title="Hidden elements"
        description={hosts.length ? "Hidden with View › Hide Element… (⇧⌘H). They stay hidden on every visit, subdomains included." : "Nothing hidden in this profile."}
        action={<ProfilePicker value={selected} onChange={setSelected} />}
      />
      {hosts.length > 0 && (
        <Group>
          {hosts.map((host) => {
            const list = byHost.get(host)!;
            const titles = list.slice(0, SHOWN_TITLES).map((e) => hiddenElementTitle(e.selector));
            const more = list.length - titles.length;
            return (
              <Row
                key={host}
                icon={<Favicon url={`https://${host}`} />}
                title={host}
                description={`${list.length} element${list.length === 1 ? "" : "s"}: ${titles.join(", ")}${more > 0 ? ` and ${more} more` : ""}`}
              >
                <Button title="Show Again" onPress={() => loaded && void restoreHiddenElements(loaded.profile, list)} />
              </Row>
            );
          })}
        </Group>
      )}
    </>
  );
}
