import { useMemo, useState } from "react";
import { Image, View } from "react-native";
import { useAirTrafficConfig, useLinkHooks, useRoutableProfiles, useRouteGroupName, useWatchRouteTargets, type LinkHookRow, type LinkHookState, type RoutableProfile } from "../../../state/airTraffic/hooks";
import { moveAirTrafficRule, removeAirTrafficRule, setAirTrafficFallback, setAirTrafficInAppLinks, updateAirTrafficRule } from "../../../state/airTraffic/store";
import { previewLink, type LinkPreview } from "../../../state/airTraffic/preview";
import type { OpeningTrace } from "../../../state/automation/decisions";
import type { AirTrafficRule, AirTrafficTarget, SourceApp } from "../../../state/airTraffic/rules";
import { showMenu } from "../../../state/app/system";
import { currentEngineProfile } from "../../../state/browser/current";
import { removeExternalAppAllowance } from "../../../state/site/siteSettings";
import { appLinks } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { goToSettingsPane } from "../../../state/settings/settingsWindows";
import { showSettingsSheet } from "../../../state/settings/sheet";
import { Box, Button, PopUp, Symbol, Text, TextField, Toggle, useTheme, type Option } from "../../ui";
import { Favicon } from "../../favicon/Favicon";
import { Group, ProfilePicker, Row, SectionHeader, useSettingsProfile } from "../Form";
import { AppPicker, CLOSED_GROUP, conditionLabel, fromLabel, GroupPicker, OPEN_LABELS, OPEN_OPTIONS, profileOptions, RuleSheet, USED_LAST } from "./AirTrafficSheet";

const USUAL = "usual";
const GROUP_CLOSED = "Its tab group isn't open, so links open as a plain tab in this profile. Edit it to pick another.";
const FALLBACK_GROUP_CLOSED = "That tab group isn't open, so these links open as a plain tab in this profile. Pick another.";
const APP_ICON = { width: 20, height: 20 } as const;
const RESULT_ICON = { width: 20, height: 20 } as const;

function targetLabel(target: AirTrafficTarget, profiles: RoutableProfile[], groupName: string | null): string | null {
  const profile = target.profileId === null ? USED_LAST : profiles.find((p) => p.id === target.profileId)?.name;
  if (!profile) return null;
  return target.groupKey ? `${profile} › ${groupName ?? CLOSED_GROUP}` : `${profile} · ${OPEN_LABELS[target.open]}`;
}

function ruleProblem(target: string | null, groupGone: boolean): string | null {
  if (!target) return "Its profile is gone, so this rule is skipped. Edit it to pick another.";
  return groupGone ? GROUP_CLOSED : null;
}

export function LinkRoutingSection({ profileId }: { profileId: string | null }) {
  const { rules } = useAirTrafficConfig();
  const hooks = useLinkHooks();
  const profiles = useRoutableProfiles();
  return (
    <View>
      <SectionHeader title="Link routing" description="Choose where links from other apps open." />
      <Box gap="xl">
        <Group>
          <Row anchor="automations.linkRules">
            <Box row gap="s">
              {hooks.length ? <Button title="Automation…" onPress={() => goToSettingsPane("advanced")} /> : null}
              <Button title="Add Rule…" icon="plus" onPress={() => showSettingsSheet(<RuleSheet />)} />
            </Box>
          </Row>
          {hooks.map((h) => (
            <HookRow key={`hook:${h.name}`} hook={h} />
          ))}
          {rules.length === 0 ? (
            <Row key="none" icon={null} title="No rules yet" description="Add one to send links from an app, or links to a site, to a profile." />
          ) : (
            rules.map((rule, i) => <RuleRow key={rule.id} rule={rule} index={i} last={i === rules.length - 1} profiles={profiles} />)
          )}
        </Group>
        <InAppLinksRow />
        <TestLink />
        <FallbackGroup profiles={profiles} />
      </Box>

      <AppLinks profileId={profileId} />
    </View>
  );
}

function RuleRow({ rule, index, last, profiles }: { rule: AirTrafficRule; index: number; last: boolean; profiles: RoutableProfile[] }) {
  const groupName = useRouteGroupName(rule.profileId, rule.groupKey);
  const target = targetLabel(rule, profiles, groupName);
  const groupGone = !!rule.groupKey && !groupName;
  const more = async () => {
    const choice = await showMenu([{ id: "edit", title: "Edit…" }, { separator: true }, { id: "up", title: "Move Up", enabled: index > 0 }, { id: "down", title: "Move Down", enabled: !last }, { separator: true }, { id: "delete", title: "Delete" }]);
    if (choice === "edit") showSettingsSheet(<RuleSheet rule={rule} />);
    else if (choice === "up" || choice === "down") moveAirTrafficRule(rule.id, choice === "up" ? -1 : 1);
    else if (choice === "delete") removeAirTrafficRule(rule.id);
  };
  return (
    <Row icon={null} title={`${fromLabel(rule.from)} · ${conditionLabel(rule.when)} → ${target ?? "a deleted profile"}`} description={ruleProblem(target, groupGone)}>
      <Toggle value={rule.enabled} accessibilityLabel="Use this rule" onChange={(enabled) => void updateAirTrafficRule(rule.id, { enabled })} />
      <Button variant="icon" icon="pencil" size="m" onPress={() => showSettingsSheet(<RuleSheet rule={rule} />)} tooltip="Edit" />
      <Button variant="icon" icon="ellipsis.circle" size="m" onPress={() => void more()} tooltip="Move or Delete" />
      <Button variant="icon" icon="trash" size="m" onPress={() => removeAirTrafficRule(rule.id)} tooltip="Delete" />
    </Row>
  );
}

const HOOK_STATES: Record<LinkHookState, string> = {
  active: "On",
  approved: "Approved",
  waiting: "Waiting for approval",
  off: "Off",
};

function hookSummary(hook: LinkHookRow): string {
  const from = hook.from.length ? `From ${hook.from.join(", ")}` : "Any app";
  const links = hook.patterns.length ? hook.patterns.join(", ") : "any link";
  return `${from} · ${links} → ${hook.answer} · ${HOOK_STATES[hook.state]}`;
}

function HookRow({ hook }: { hook: LinkHookRow }) {
  const theme = useTheme();
  return (
    <Row icon={<Symbol name="lock.fill" size={13} color={theme.icon} />} title={hook.name} description={hookSummary(hook)}>
      <Text size="caption" tone="textSecondary">
        hooks.json
      </Text>
    </Row>
  );
}

function FallbackGroup({ profiles }: { profiles: RoutableProfile[] }) {
  const { fallback } = useAirTrafficConfig();
  const fallbackOpensTabIn = fallback?.open === "tab" ? profiles.find((p) => p.id === fallback.profileId) : undefined;
  return (
    <Group>
      <FallbackRow profiles={profiles} />
      {fallbackOpensTabIn ? <FallbackGroupRow /> : null}
    </Group>
  );
}

function FallbackRow({ profiles }: { profiles: RoutableProfile[] }) {
  const { fallback } = useAirTrafficConfig();
  const options: Option<string>[] = [
    { value: USUAL, title: "Ardia's usual routing" },
    ...profileOptions(profiles).map((o, i) => ({
      ...o,
      separatorBefore: i <= 1,
    })),
  ];
  const value = !fallback ? USUAL : (fallback.profileId ?? "");
  const pick = (choice: string) =>
    setAirTrafficFallback(
      choice === USUAL
        ? null
        : {
            profileId: choice || null,
            open: fallback?.open ?? "tab",
            ...(choice === fallback?.profileId && fallback.groupKey ? { groupKey: fallback.groupKey } : {}),
          },
    );
  return (
    <Row anchor="automations.linkFallback" description={fallback ? undefined : "They open as Settings › Tabs says, in the profile you used last."}>
      <PopUp value={value} options={options} onChange={pick} minWidth={180} />
      {fallback ? <PopUp value={fallback.open} options={OPEN_OPTIONS} onChange={(open) => setAirTrafficFallback({ ...fallback, open })} /> : null}
    </Row>
  );
}

function FallbackGroupRow() {
  const { fallback } = useAirTrafficConfig();
  const groupName = useRouteGroupName(fallback?.profileId ?? null, fallback?.groupKey);
  if (!fallback?.profileId || fallback.open !== "tab") return null;
  const groupGone = !!fallback.groupKey && !groupName;
  return (
    <Row anchor="automations.linkFallbackGroup" description={groupGone ? FALLBACK_GROUP_CLOSED : undefined}>
      <GroupPicker
        profileId={fallback.profileId}
        value={fallback.groupKey ?? ""}
        onChange={(groupKey) =>
          setAirTrafficFallback({
            ...fallback,
            groupKey: groupKey || undefined,
          })
        }
      />
    </Row>
  );
}

function landing(preview: Extract<LinkPreview, { ok: true }>): string {
  if (preview.dropped) return "Dropped: nothing opens.";
  const where = preview.groupName ? ` › ${preview.groupName}` : "";
  return `Opens in ${preview.profileName}${preview.usedLast ? " (used last)" : ""}${where} · ${OPEN_LABELS[preview.open]}`;
}

function openingNote(opening: OpeningTrace): string {
  if (opening.by === "rewrite") return ` hooks.json: ${opening.hook} changes the link to ${opening.url} first.`;
  if (opening.by === "program") return ` hooks.json: ${opening.hook.name} may change the link first; this shows it unchanged.`;
  return "";
}

function caughtBy(preview: Extract<LinkPreview, { ok: true }>): {
  title: string;
  detail: string;
} {
  const opening = preview.opening;
  if (opening.by === "cancel")
    return {
      title: `hooks.json: ${opening.hook} blocks it`,
      detail: "Nothing opens.",
    };
  const trace = preview.trace!;
  const lands = landing(preview) + openingNote(opening);
  if (trace.by === "rule")
    return {
      title: `Rule ${trace.index + 1}: ${fromLabel(trace.rule.from)} · ${conditionLabel(trace.rule.when)}`,
      detail: lands,
    };
  if (trace.by === "hook") return { title: `hooks.json: ${trace.hook}`, detail: lands };
  if (trace.by === "program")
    return {
      title: `hooks.json: ${trace.hook.name} asks ${trace.hook.program?.[0] ?? "a program"}`,
      detail: `If it doesn't answer: ${lands}`,
    };
  if (trace.by === "fallback") return { title: "Links no rule catches", detail: lands };
  return {
    title: "No rule catches it",
    detail: `Ardia's usual routing. ${lands}`,
  };
}

function InAppLinksRow() {
  const { inAppLinks } = useAirTrafficConfig();
  return (
    <Group>
      <Row anchor="automations.inAppLinks">
        <Toggle value={inAppLinks} accessibilityLabel="Also route links you open inside Ardia" onChange={setAirTrafficInAppLinks} />
      </Row>
    </Group>
  );
}

function TestLink() {
  const theme = useTheme();
  const { rules } = useAirTrafficConfig();
  const [app, setApp] = useState<SourceApp | null>(null);
  const [typed, setTyped] = useState("");
  useWatchRouteTargets();
  const extras = useMemo(() => rules.map((r) => r.from), [rules]);
  const preview = typed.trim() ? previewLink(typed, app ? { bundleId: app.bundleId, appName: app.name } : null) : null;
  const result = preview?.ok ? caughtBy(preview) : null;
  return (
    <Group of="automations.testLink">
      <Row anchor="automations.testLink">
        <AppPicker value={app} onChange={(a) => setApp(a === "other" ? null : a)} anyTitle="An unknown app" extras={extras} />
      </Row>
      <Row icon={null} title={<TextField value={typed} onChangeText={setTyped} placeholder="Paste a link, like github.com/ardia" />} />
      <Row
        icon={<Symbol name={result ? "airplane" : "link"} size={13} color={theme.icon} style={RESULT_ICON} />}
        title={result?.title ?? (preview ? "That isn't a link Ardia can open." : "Type a link to see where it lands.")}
        description={result?.detail ?? null}
      />
    </Group>
  );
}

function AppLinks({ profileId: initialProfileId }: { profileId: string | null }) {
  const [profileId, setProfileId] = useSettingsProfile(initialProfileId);
  const [loaded, reload] = useResource(appLinks, currentEngineProfile(profileId));
  const allowed = loaded ?? null;
  const refresh = () => void reload();

  return (
    <>
      <SectionHeader anchor="automations.appLinks" title="Apps that open links" action={<ProfilePicker value={profileId} onChange={setProfileId} />} />
      <Group of="automations.appLinks">
        {allowed === null ? (
          <Row icon={null} title=" " description=" " />
        ) : allowed.length === 0 ? (
          <Row icon={null} title="No apps yet" description="Check “Always allow” when a site opens an app, and it shows up here." />
        ) : (
          allowed.map((a) => (
            <Row
              key={`${a.origin}|${a.scheme}`}
              icon={a.icon ? <Image source={{ uri: a.icon }} style={APP_ICON} /> : <Favicon url={a.origin} />}
              title={a.origin.replace(/^https?:\/\//, "")}
              description={`Opens ${a.scheme}: links in ${a.app ?? "an app that's no longer installed"}`}
            >
              <Button title="Remove" onPress={() => void removeExternalAppAllowance(currentEngineProfile(profileId), a.origin, a.scheme).then(refresh)} />
            </Row>
          ))
        )}
      </Group>
    </>
  );
}
