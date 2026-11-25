import { num, query, str } from "../clickhouse";
import { frameNames } from "../frame-symbols";
import { APP_SOURCE, prop } from "../sql";
import { topOwnFrames } from "../../lib/freeze-frames";
import { frameLabel, frameName } from "../../lib/native-frames";

export type FreezeSignature = {
  signature: string;
  people: number;
  freezes: number;
  frozenMs: number;
  thread: string;
  activity: string;
  latestVersion: string;
  topFrames: string[];
  rawFrames: string[];
  named: boolean;
};

export async function freezesBySignature(signal?: AbortSignal) {
  const rows = await query(
    `SELECT properties['signature'] AS signature,
       uniqExact(distinct_id) AS people,
       count() AS freezes,
       sum(toUInt64OrZero(properties['freeze_ms'])) AS frozen_ms,
       topK(1)(properties['freeze_thread'])[1] AS thread,
       topK(1)(properties['activity'])[1] AS activity,
       max(${prop("$app_version")}) AS latest_version,
       argMax(properties['freeze_frames'], timestamp) AS frames,
       argMax(properties['freeze_images'], timestamp) AS images
     FROM telemetry.events
     WHERE event = 'app_freeze' AND timestamp >= now() - INTERVAL 7 DAY AND ${APP_SOURCE} AND properties['signature'] != ''
     GROUP BY signature
     ORDER BY people DESC, frozen_ms DESC
     LIMIT 50`,
    signal,
  );
  const tops = rows.map((r) => topOwnFrames(str(r[7]), str(r[8])));
  const names = await frameNames(tops.flat(), signal);
  const signatures: FreezeSignature[] = rows.map((r, i) => ({
    signature: str(r[0]),
    people: num(r[1]),
    freezes: num(r[2]),
    frozenMs: num(r[3]),
    thread: str(r[4]),
    activity: str(r[5]),
    latestVersion: str(r[6]),
    topFrames: tops[i]!.map((f) => frameLabel(f, names)),
    rawFrames: tops[i]!.map((f) => f.raw),
    named: tops[i]!.some((f) => frameName(f, names)),
  }));
  return {
    signatures,
    people: signatures.reduce((n, s) => Math.max(n, s.people), 0),
    freezes: signatures.reduce((n, s) => n + s.freezes, 0),
    frozenMs: signatures.reduce((n, s) => n + s.frozenMs, 0),
    namedPlaces: signatures.filter((s) => s.named).length,
  };
}
