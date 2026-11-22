import { readDocument } from "../../platform/documents";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";

export const FREEZE_RECORDS_DOC = "freezes.txt";
const SLOT_BYTES = 4096;

export type LocalFreezeFrame = { image: string; offset: string };
export type LocalFreeze = {
  seq: number;
  thread: string;
  recovered: boolean;
  startedMs: number;
  durationMs: number;
  activity: string;
  samples: LocalFreezeFrame[][];
  text: string;
};

const HEADER = /^freeze (\d+) (main|js) (frozen|recovered)$/;
const FRAME = /^ {2}([A-Za-z0-9 ._-]{1,40}) \+(0x[0-9a-f]{1,16})$/;

export function parseFreezeRecords(file: string | null | undefined): LocalFreeze[] {
  if (!file) return [];
  const records: LocalFreeze[] = [];
  for (let at = 0; at + 1 < file.length; at += SLOT_BYTES) {
    const text = file.slice(at, at + SLOT_BYTES);
    const end = text.indexOf("\nend\n");
    if (end < 0) continue;
    const lines = text.slice(0, end).split("\n");
    const head = HEADER.exec(lines[0] ?? "");
    if (!head) continue;
    const field = (name: string) => lines.find((l) => l.startsWith(`${name} `))?.slice(name.length + 1) ?? "";
    const samples: LocalFreezeFrame[][] = [];
    for (const line of lines) {
      if (line.startsWith("sample ")) samples.push([]);
      const frame = FRAME.exec(line);
      if (frame && samples.length) samples.at(-1)!.push({ image: frame[1]!, offset: frame[2]! });
    }
    records.push({
      seq: Number(head[1]),
      thread: head[2]!,
      recovered: head[3] === "recovered",
      startedMs: Number(field("started_ms")) || 0,
      durationMs: Number(field("duration_ms")) || 0,
      activity: /^[A-Za-z0-9_]{1,24}$/.test(field("activity")) ? field("activity") : "none",
      samples,
      text: text.slice(0, end + 4),
    });
  }
  return records.sort((a, b) => a.seq - b.seq);
}

export const localFreezes = () => parseFreezeRecords(readDocument(FREEZE_RECORDS_DOC));

const OWN_IMAGE = /^(Ardia|Chromium Framework|hermes)/;

export function topOwnFrame(record: LocalFreeze): string | null {
  const frame = record.samples[0]?.find((f) => OWN_IMAGE.test(f.image));
  return frame ? `${frame.image} +${frame.offset}` : null;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

export function freezeSummaryLine(records: LocalFreeze[], now = Date.now()): string {
  if (!PLATFORM_FEATURES.freezeWatch) return "Freezes: not recorded on this platform";
  const today = records.filter((r) => sameDay(r.startedMs, now));
  const last = records.at(-1);
  if (!last) return "Freezes: none recorded";
  const longest = Math.max(...today.map((r) => r.durationMs), 0);
  const cause = last.activity !== "none" ? last.activity : (topOwnFrame(last) ?? "no frames from Ardia");
  return `Freezes: ${today.length} today${today.length ? `, longest ${seconds(longest)}` : ""}; last ${seconds(last.durationMs)} on the ${last.thread} thread${last.recovered ? "" : " (did not recover)"}, cause ${cause}`;
}

export function lastFreezeText(records: LocalFreeze[]): string {
  if (!PLATFORM_FEATURES.freezeWatch) return "Freeze records aren't kept on this platform.";
  const last = records.at(-1);
  return last ? `${new Date(last.startedMs).toISOString()}\n${last.text}` : "No freezes recorded.";
}
