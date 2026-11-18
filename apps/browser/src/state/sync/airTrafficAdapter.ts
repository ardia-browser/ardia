import { assignPositions, canonical, type Adapter } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { airTrafficJson, cleanRule, cleanTarget, fallbackChosen, MAX_AIR_TRAFFIC_RULES, parseAirTraffic, type AirTrafficConfig, type AirTrafficRule, type AirTrafficTarget } from "../airTraffic/rules";
import { applySyncedAirTraffic, currentAirTraffic } from "../airTraffic/store";
import { AIR_TRAFFIC, AIR_TRAFFIC_FALLBACK, AIR_TRAFFIC_RULE, airTrafficFallbackRecord, airTrafficRuleRecord, recordId, type AirTrafficFallbackRecord, type AirTrafficRuleRecord } from "./records";

type Links = () => Record<string, { syncId: string }>;

type Placed = { rule: AirTrafficRule; pos: string };

const ruleKey = (id: string) => `${AIR_TRAFFIC_RULE}${id}`;

function profileMaps(links: Links) {
  const syncOf = new Map<string, string>();
  const localOf = new Map<string, string>();
  for (const [id, { syncId }] of Object.entries(links())) {
    if (!useBrowser.getState().profiles[id]) continue;
    syncOf.set(id, syncId);
    localOf.set(syncId, id);
  }
  return { syncOf, localOf };
}

const syncRef = (profileId: string | null, syncOf: Map<string, string>) => (profileId === null ? null : syncOf.get(profileId));

const localRef = (p: string | null, localOf: Map<string, string>) => (p === null ? null : localOf.get(p));

function ruleRecord(rule: AirTrafficRule, p: string | null, pos: string): AirTrafficRuleRecord {
  const { groupKey } = cleanRule(rule);
  return { on: rule.enabled, from: rule.from, when: rule.when, open: rule.open, p, ...(groupKey ? { g: groupKey } : {}), pos };
}

function fallbackRecord(config: AirTrafficConfig, p: string | null): AirTrafficFallbackRecord {
  const target = config.fallback && cleanTarget(config.fallback);
  return { t: target ? { p, open: target.open, ...(target.groupKey ? { g: target.groupKey } : {}) } : null, chosen: fallbackChosen(config) };
}

function ruleFrom(id: string, record: AirTrafficRuleRecord, profileId: string | null): AirTrafficRule | null {
  const rule: AirTrafficRule = { id, enabled: record.on, from: record.from, when: record.when, profileId, open: record.open, ...(record.g ? { groupKey: record.g } : {}) };
  return parseAirTraffic(airTrafficJson({ rules: [rule], fallback: null })).rules[0] ?? null;
}

function fallbackFrom(t: NonNullable<AirTrafficFallbackRecord["t"]>, profileId: string | null): AirTrafficTarget | null {
  const target: AirTrafficTarget = { profileId, open: t.open, ...(t.g ? { groupKey: t.g } : {}) };
  return parseAirTraffic(airTrafficJson({ rules: [], fallback: target })).fallback;
}

function byPosition(a: Placed, b: Placed) {
  if (a.pos !== b.pos) return a.pos < b.pos ? -1 : 1;
  const [x, y] = [ruleKey(a.rule.id), ruleKey(b.rule.id)];
  return x < y ? -1 : x > y ? 1 : 0;
}

export function airTrafficAdapter(links: Links): Adapter {
  return {
    prefix: AIR_TRAFFIC,
    adoptRemoteOnJoin: true,
    extract: (base, _queued, _now, known, remote) => {
      const { syncOf, localOf } = profileMaps(links);
      const config = currentAirTraffic();
      const waiting = (key: string) => known(key) && canonical(remote(key) ?? null) !== canonical(base(key) ?? null);
      const syncable = config.rules.flatMap((rule) => {
        const p = syncRef(rule.profileId, syncOf);
        return p === undefined ? [] : [{ rule, p, key: ruleKey(rule.id) }];
      });
      const positions = assignPositions(syncable.map(({ key }) => airTrafficRuleRecord(base(key))?.pos));
      const values = new Map<string, unknown>();
      syncable.forEach(({ rule, p, key }, i) => {
        if (!waiting(key)) values.set(key, ruleRecord(rule, p, positions[i]!));
      });
      const p = config.fallback === null ? null : syncRef(config.fallback.profileId, syncOf);
      if (p !== undefined && !waiting(AIR_TRAFFIC_FALLBACK) && (config.fallback !== null || fallbackChosen(config) || known(AIR_TRAFFIC_FALLBACK))) {
        values.set(AIR_TRAFFIC_FALLBACK, fallbackRecord(config, p));
      }
      const ignore = (key: string) => {
        if (key === AIR_TRAFFIC_FALLBACK || waiting(key)) return true;
        const record = airTrafficRuleRecord(base(key));
        return !record || (record.p !== null && !localOf.has(record.p));
      };
      return { values, ignore };
    },
    apply: (visible, changed, base, records) => {
      const { localOf } = profileMaps(links);
      const config = currentAirTraffic();
      const incoming = new Map<string, Placed>();
      const dropped = new Set<string>();
      const applied: string[] = [];
      let complete = true;
      let fallback = config.fallback;
      let chosen = config.fallbackChosen === true;
      for (const key of changed) {
        const value = visible.get(key);
        if (key === AIR_TRAFFIC_FALLBACK) {
          const record = value === undefined ? null : airTrafficFallbackRecord(value);
          const p = record?.t ? localRef(record.t.p, localOf) : null;
          const target = record?.t && p !== undefined ? fallbackFrom(record.t, p) : null;
          if (value === undefined) applied.push(key);
          else if (!record || (record.t && !target)) complete = false;
          else {
            fallback = target;
            chosen = record.chosen;
            applied.push(key);
          }
        } else if (key.startsWith(AIR_TRAFFIC_RULE)) {
          const id = recordId(AIR_TRAFFIC_RULE, key);
          if (value === undefined) {
            dropped.add(id);
            applied.push(key);
            continue;
          }
          const record = airTrafficRuleRecord(value);
          const profileId = record ? localRef(record.p, localOf) : undefined;
          const rule = record && profileId !== undefined ? ruleFrom(id, record, profileId) : null;
          if (record && rule) {
            incoming.set(id, { rule, pos: record.pos });
            applied.push(key);
          } else complete = false;
        } else complete = false;
      }
      const placed: Placed[] = [];
      const local: { rule: AirTrafficRule; index: number }[] = [];
      config.rules.forEach((rule, index) => {
        if (dropped.has(rule.id)) return;
        const next = incoming.get(rule.id);
        const pos = airTrafficRuleRecord(base(ruleKey(rule.id)))?.pos;
        if (next) placed.push(next);
        else if (pos !== undefined) placed.push({ rule, pos });
        else local.push({ rule, index });
        incoming.delete(rule.id);
      });
      placed.push(...incoming.values());
      const rules = placed.sort(byPosition).map(({ rule }) => rule);
      for (const { rule, index } of local) rules.splice(Math.min(index, rules.length), 0, rule);
      if (rules.length > MAX_AIR_TRAFFIC_RULES) return false;
      if (!applySyncedAirTraffic({ rules, fallback, ...(chosen ? { fallbackChosen: true as const } : {}) })) return false;
      for (const key of applied) records.landed(key);
      return complete;
    },
  };
}
