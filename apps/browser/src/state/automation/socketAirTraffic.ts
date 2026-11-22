import type { JsonSchema } from "../../lib/jsonSchema";
import { isIncognitoProfile } from "../browser/model";
import { routeGroups } from "../airTraffic/groups";
import { SHARED_GROUPS_SIDEBAR_ONLY, sharedRoot } from "./workspaceSharedGuard";
import { pinKeyOf } from "../browser/model";
import { previewLink } from "../airTraffic/preview";
import { cleanRule, cleanTarget, linkTextProblem, sameTarget, MAX_AIR_TRAFFIC_RULES, OPEN_AS, patternProblem, siteHost, sourceAppOf, type AirTrafficRule, type AirTrafficTarget, type LinkCondition, type OpenAs } from "../airTraffic/rules";
import { currentAirTraffic, placeAirTrafficRule, removeAirTrafficRule, setAirTrafficFallback, targetUsableNow, tryAddAirTrafficRule, updateAirTrafficRule, type RuleDraft } from "../airTraffic/store";
import type { MethodSpec } from "./socketCatalog";
import { bool, id, obj, oneOf, text } from "./socketSchema";
import { expect, now } from "./socketTargets";
import { OpError } from "./workspaceTargets";
import { t } from "../../lib/uiLanguage";


const CONDITION_KINDS = ["any", "site", "pattern", "contains", "equals"] as const;
const REFUSED = { full: `There are already ${MAX_AIR_TRAFFIC_RULES} rules.`, exists: t(`A rule with that id exists.`), unsaved: t(`air-traffic.json couldn't be saved.`) } as const;

function conditionOf(value: Record<string, unknown>): LinkCondition {
  const fields = Object.keys(value).filter((k) => k !== "kind");
  const only = (key: string) => {
    if (typeof value[key] !== "string" || fields.some((k) => k !== key)) throw new OpError("bad_request", `when of kind ${String(value.kind)} takes ${key} and nothing else.`);
    return value[key] as string;
  };
  if (value.kind === "any") {
    if (fields.length) throw new OpError("bad_request", t(`when of kind any takes nothing else.`));
    return { kind: "any" };
  }
  if (value.kind === "site") {
    const host = siteHost(only("host"));
    if (!host) throw new OpError("bad_request", `${String(value.host)} isn't a site like example.com.`);
    return { kind: "site", host };
  }
  if (value.kind === "pattern") {
    const pattern = only("pattern").trim();
    const problem = patternProblem(pattern);
    if (problem) throw new OpError("bad_request", `pattern: ${problem}.`);
    return { kind: "pattern", pattern };
  }
  const kind = value.kind as "contains" | "equals";
  const linkText = only("text");
  const problem = linkTextProblem(kind, linkText);
  if (problem) throw new OpError("bad_request", `text: ${problem}.`);
  return { kind, text: linkText };
}

function profileOf(value: unknown): string | null {
  if (value === null) return null;
  const s = now();
  if (typeof value !== "string" || !Object.hasOwn(s.profiles, value) || isIncognitoProfile(value)) throw new OpError("no_window", `There's no profile ${String(value)}.`);
  return value;
}

function groupKeyInSharedFolder(profileId: string, groupKey: string): boolean {
  const s = now();
  return Object.values(s.groups).some((g) => g.profileId === profileId && pinKeyOf(g) === groupKey && !!sharedRoot(s, g.id));
}

function targetOf(params: Record<string, unknown>, base: AirTrafficTarget): AirTrafficTarget {
  const profileId = params.profile !== undefined ? profileOf(params.profile) : base.profileId;
  const open = (params.open as OpenAs | undefined) ?? base.open;
  const kept = params.profile !== undefined || open !== "tab" ? undefined : base.groupKey;
  const groupKey = params.group !== undefined ? (params.group as string | null) : kept;
  if (groupKey) {
    if (open !== "tab") throw new OpError("bad_request", t(`Only links opened as a tab go into a group.`));
    if (params.group !== undefined && (profileId === null || !targetUsableNow(profileId, groupKey))) throw new OpError("no_window", `There's no group ${groupKey} in that profile; airTraffic.rules lists them.`);
  }
  return { profileId, open, groupKey: groupKey ?? undefined };
}

function draftOf(params: Record<string, unknown>, base: RuleDraft): RuleDraft {
  const from = params.from === undefined ? base.from : params.from === null ? null : sourceAppOf({ bundleId: null, ...(params.from as object) });
  if (params.from && !from) throw new OpError("bad_request", t(`from is {name, bundleId?}, an app's name and its bundle id.`));
  const when = params.when !== undefined ? conditionOf(params.when as Record<string, unknown>) : base.when;
  const enabled = (params.enabled as boolean | undefined) ?? base.enabled;
  const target = targetOf(params, base);
  if (enabled && target.groupKey && target.profileId && groupKeyInSharedFolder(target.profileId, target.groupKey)) {
    throw new OpError("refused", `Group ${target.groupKey} is a shared folder; ${SHARED_GROUPS_SIDEBAR_ONLY}, so links from other apps can't be sent into it from here. The rule can still be turned off.`);
  }
  return { enabled, from, when, ...target };
}

function ruleOf(ruleId: unknown): AirTrafficRule {
  const rule = currentAirTraffic().rules.find((r) => r.id === ruleId);
  if (!rule) throw new OpError("no_window", `There's no Air Traffic rule ${String(ruleId)}.`);
  return rule;
}

function overview() {
  const s = now();
  const config = currentAirTraffic();
  const profiles = s.profileOrder.filter((p) => s.profiles[p] && !isIncognitoProfile(p)).map((p) => ({ id: p, name: s.profiles[p]!.name, groups: routeGroups(s, p) }));
  return { rules: config.rules, fallback: config.fallback, fallbackChosen: !!config.fallbackChosen, profiles };
}

function addRule(params: Record<string, unknown>) {
  const added = tryAddAirTrafficRule(draftOf(params, { enabled: true, from: null, when: { kind: "any" }, profileId: null, open: "tab" }));
  if ("refused" in added) throw new OpError(added.refused === "unsaved" ? "failed" : "refused", REFUSED[added.refused]);
  return ruleOf(added.id);
}

function updateRule(params: Record<string, unknown>) {
  const { id: ruleId, ...rest } = params;
  const was = ruleOf(ruleId);
  if (!Object.keys(rest).length) throw new OpError("bad_request", t(`airTraffic.updateRule needs something to change.`));
  const draft = draftOf(rest, was);
  updateAirTrafficRule(was.id, draft);
  expect(JSON.stringify(ruleOf(was.id)) === JSON.stringify(cleanRule({ ...was, ...draft, id: was.id })), t(`air-traffic.json couldn't be saved.`));
  return ruleOf(was.id);
}

function removeRule(params: Record<string, unknown>) {
  const rule = ruleOf(params.id);
  removeAirTrafficRule(rule.id);
  expect(!currentAirTraffic().rules.some((r) => r.id === rule.id), t(`air-traffic.json couldn't be saved.`));
  return { ok: true };
}

function moveRule(params: Record<string, unknown>) {
  const rule = ruleOf(params.id);
  const rules = currentAirTraffic().rules;
  const to = Math.max(0, Math.min(rules.length - 1, params.index as number));
  if (rules.indexOf(rule) !== to) placeAirTrafficRule(rule.id, to);
  expect(currentAirTraffic().rules.findIndex((r) => r.id === rule.id) === to, t(`air-traffic.json couldn't be saved.`));
  return currentAirTraffic().rules.map((r) => r.id);
}

function setFallback(params: Record<string, unknown>) {
  const target = params.open === null ? null : targetOf(params, { profileId: null, open: "tab" });
  if (params.open === null && (params.profile !== undefined || params.group !== undefined)) throw new OpError("bad_request", t(`open: null clears the fallback and takes nothing else.`));
  if (target?.groupKey && target.profileId && groupKeyInSharedFolder(target.profileId, target.groupKey)) {
    throw new OpError("refused", `Group ${target.groupKey} is a shared folder; ${SHARED_GROUPS_SIDEBAR_ONLY}, so links from other apps can't be sent into it from here.`);
  }
  setAirTrafficFallback(target);
  expect(!!currentAirTraffic().fallbackChosen && sameTarget(currentAirTraffic().fallback, target && cleanTarget(target)), t(`air-traffic.json couldn't be saved.`));
  return { fallback: currentAirTraffic().fallback };
}

function testLink(params: Record<string, unknown>) {
  const from = params.from as { name?: string; bundleId?: string } | undefined;
  const preview = previewLink(params.url as string, from ? { bundleId: from.bundleId ?? null, appName: from.name ?? null } : null);
  if (!preview.ok) throw new OpError("bad_request", `${String(params.url)} isn't a link Ardia can open.`);
  const { trace: _trace, opening: _opening, ...shown } = preview;
  return shown;
}

const APP: JsonSchema = { type: ["object", "null"], properties: { name: text(t(`The app's name, like Slack`)), bundleId: text(t(`Its bundle id, like com.tinyspeck.slackmacgap`)) }, required: ["name"], additionalProperties: false, description: t(`The app the link comes from; any app when null`) };
const WHEN: JsonSchema = {
  type: "object",
  properties: { kind: oneOf(CONDITION_KINDS, t(`any link, a site, a match pattern, or text the link contains or equals`)), host: text(t(`For site: example.com`)), pattern: text("For pattern: *github* or https://*.example.com/docs/*"), text: text(t(`For contains and equals`)) },
  required: ["kind"],
  additionalProperties: false,
  description: t(`Which links`),
};
const TARGET: Record<string, JsonSchema> = {
  profile: { type: ["string", "null"], description: t(`A profile id from profiles.list; null for the profile used last`) },
  open: oneOf(OPEN_AS, t(`Open as a tab, a new window or in Little Ardia`)),
  group: { type: ["string", "null"], description: t(`A group key from airTraffic.rules; only when open is tab`) },
};
const RULE = { from: APP, when: WHEN, ...TARGET, enabled: bool(t(`On or off`)) };
const RULE_ROW = t(`{id, enabled, from, when, profileId, open, groupKey?}`);

export const AIR_TRAFFIC_METHODS: MethodSpec[] = [
  { name: "airTraffic.rules", mutates: false, description: t(`Air Traffic Control: the rules routing links from other apps, the Everything Else choice, and the profiles and groups a rule can send to`), params: obj({}), result: t(`{rules, fallback, fallbackChosen, profiles: [{id, name, groups: [{key, name}]}]}`), run: overview },
  { name: "airTraffic.addRule", mutates: true, description: t(`Add a rule at the end; any app, any link, a tab in the last used profile unless given`), params: obj(RULE), result: RULE_ROW, run: addRule },
  { name: "airTraffic.updateRule", mutates: true, description: t(`Change a rule`), params: obj({ id: id(t(`A rule id from airTraffic.rules`)), ...RULE }, ["id"]), result: RULE_ROW, run: updateRule },
  { name: "airTraffic.removeRule", mutates: true, description: t(`Delete a rule`), params: obj({ id: id(t(`A rule id from airTraffic.rules`)) }, ["id"]), result: "{ok}", run: removeRule },
  { name: "airTraffic.moveRule", mutates: true, description: t(`Move a rule; the first rule that matches a link wins`), params: obj({ id: id(t(`A rule id from airTraffic.rules`)), index: { type: "integer", minimum: 0, description: t(`Its new place, 0 first`) } }, ["id", "index"]), result: t(`[rule id]`), run: moveRule },
  {
    name: "airTraffic.setFallback",
    mutates: true,
    description: t(`Where links no rule matches go (Everything Else); open: null puts them back to Ardia's usual choice`),
    params: obj({ ...TARGET, open: { type: ["string", "null"], enum: [...OPEN_AS, null], description: t(`tab, window or littleArdia; null clears it`) } }, ["open"]),
    result: "{fallback}",
    run: setFallback,
  },
  { name: "airTraffic.test", mutates: false, description: t(`Where a link from an app would open now, as the Settings pane's tester shows it`), params: obj({ url: text(t(`A link`)), from: { ...APP, type: "object" } }, ["url"]), result: t(`{ok, url, dropped, profileName, groupName, usedLast, open}`), run: testLink },
];
