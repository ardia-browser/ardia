import { countUsage } from "../telemetry/telemetry";

let counted = false;
let duoCounted = false;

export function noteWindowShape(width: number, height: number) {
  if (counted || width <= height) return;
  counted = true;
  countUsage("landscape_shown");
}

export function noteScreenLayoutName(name: "phone" | "column" | "wide" | "split") {
  if (duoCounted || name === "phone") return;
  duoCounted = true;
  countUsage("duo_layout_shown");
}

export const forgetLandscapeCount = () => {
  counted = false;
  duoCounted = false;
};
