import { displayCornerRadius } from "../../platform/system";

let read: number | null | undefined;

export function screenCornerRadius(fallback: number): number {
  if (read === undefined) read = displayCornerRadius();
  return read ?? fallback;
}
