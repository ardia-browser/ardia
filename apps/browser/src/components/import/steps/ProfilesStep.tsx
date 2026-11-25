import { t, tp } from "../../../lib/i18n";
import { Button, Group, space, Text } from "../../ui";
import { APP } from "../model";
import { Spacer, TargetPicker, Title } from "../Parts";
import { Monogram, ProfileAvatar, SelectRow, SpaceIcon } from "../Rows";
import {
  backTo,
  importsBySpaces,
  setImportTarget,
  spacelessProfiles,
  spacesOf,
  toggleImportSpace,
  toggleSourceProfile,
  type ImportFlow,
} from "../../../state/import/flow";
import { continueImport } from "../../../state/import/runImport";
import type { BrowserSource } from "../../../state/import/apply";

const firstSpaceNote =
  t("The first space goes into your selected profile and the others become new profiles. If Personal is your only profile and you haven't changed it, it takes the first space's name, emoji and color instead.");

const spacesNote = (name: string, zen: boolean) =>
  zen
    ? t("Customize which spaces to bring over to {app}. {firstSpaceNote} The spaces of one {name} profile share its logins, cookies and history, and a space tied to a container gets a profile of its own with that container's Essentials.", { app: APP, name, firstSpaceNote })
    : t("Customize which spaces to bring over to {app}. {firstSpaceNote} The spaces of one {name} profile share its logins, cookies, extensions and history, as in {name}.", { app: APP, name, firstSpaceNote });

function spaceSubtitle(source: BrowserSource, s: ReturnType<typeof spacesOf>[number]) {
  const withSpaces = source.profiles.filter((p) => p.spaces?.length);
  const from = withSpaces.length > 1 ? source.profiles.find((p) => p.id === s.profileId)?.name : undefined;
  return [tp("{count} pinned tab", "{count} pinned tabs", s.pinnedCount), tp("{count} tab", "{count} tabs", s.tabCount), from, s.containerName ? t("{name} container", { name: s.containerName }) : undefined]
    .filter(Boolean)
    .join(" · ");
}

export function ProfilesBody({ flow }: { flow: ImportFlow }) {
  const { source, spaces, sourceProfiles } = flow;
  if (!source) return null;
  if (importsBySpaces(source))
    return (
      <>
        <Title title={t("Select spaces to import")} subtitle={t("We'll import your {source} spaces, tabs, and folders to {app}.", { source: source.name, app: APP })} />
        <Text size="small" tone="textSecondary" style={{ marginBottom: space.ml }}>{spacesNote(source.name, source.sidebar === "zen")}</Text>
        <Group>
          {spacesOf(source).map((s) => (
            <SelectRow
              key={s.id}
              selected={spaces.includes(s.id)}
              onToggle={(v) => toggleImportSpace(s.id, v)}
              icon={<SpaceIcon space={s} />}
              title={s.name || t("Space")}
              subtitle={spaceSubtitle(source, s)}
            />
          ))}
          {source.sidebar !== "zen"
            ? null
            : spacelessProfiles(source).map((p) => (
                <SelectRow
                  key={p.id}
                  selected={sourceProfiles.includes(p.id)}
                  onToggle={(v) => toggleSourceProfile(p.id, v)}
                  icon={<Monogram name={p.name} color={p.color} />}
                  title={p.name}
                  subtitle={p.isDefault ? t("Default profile") : undefined}
                />
              ))}
        </Group>
      </>
    );
  return (
    <>
      <Title title={t("Unlock your data for import")} subtitle={t("Select the profiles you want to import.")} />
      <Text size="small" tone="textSecondary" style={{ marginBottom: space.ml }}>{t("Customize which profiles to bring over to {app}. The first goes into your selected profile; the others become new profiles.", { app: APP })}</Text>
      <Group>
        {source.profiles.map((p) => (
          <SelectRow
            key={p.id}
            selected={sourceProfiles.includes(p.id)}
            onToggle={(v) => toggleSourceProfile(p.id, v)}
            icon={<ProfileAvatar path={p.avatarPath} name={p.name} color={p.color} />}
            title={p.name}
            subtitle={p.email ?? (p.isDefault ? t("Default profile") : undefined)}
          />
        ))}
      </Group>
    </>
  );
}

export function ProfilesFooter({ flow }: { flow: ImportFlow }) {
  const { source, spaces, sourceProfiles } = flow;
  if (!source) return null;
  const bySpaces = importsBySpaces(source);
  return (
    <>
      <Button title={t("Back")} onPress={() => backTo("choose")} />
      <Spacer />
      <TargetPicker target={flow.target} onChange={setImportTarget} />
      <Button
        title={t("Continue")}
        kind="primary"
        disabled={bySpaces ? !spaces.length && (source.sidebar !== "zen" || !spacelessProfiles(source).some((p) => sourceProfiles.includes(p.id))) : !sourceProfiles.length}
        onPress={continueImport}
      />
    </>
  );
}
