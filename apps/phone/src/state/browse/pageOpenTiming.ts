import { labTrace } from "../../platform/lab";
import { reportPageOpen } from "../telemetry/telemetry";

let opening: { id: string; at: number; isPrivate: boolean } | null = null;

export function markPageOpened(id: string, isPrivate: boolean, at: number = Date.now()) {
  opening = { id, at, isPrivate };
}

export function markPageDrawn(id: string, at: number = Date.now()) {
  if (opening?.id !== id) return;
  const ms = at - opening.at;
  const privately = opening.isPrivate;
  opening = null;
  labTrace(`PAGELAB page open drawn ${ms}`);
  if (!privately) reportPageOpen(ms);
}
