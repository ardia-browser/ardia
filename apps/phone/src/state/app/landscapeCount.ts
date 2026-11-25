import { countUsage } from "../telemetry/telemetry";
import type { ScreenHinge, ScreenLayout } from "./screenLayout";

let counted = false;
let duoCounted = false;

export function noteWindowShape(width: number, height: number) {
  if (counted || width <= height) return;
  counted = true;
  countUsage("landscape_shown");
}

export function noteScreenLayout(name: ScreenLayout["name"], hinge: ScreenHinge) {
  if (duoCounted || (name === "phone" && hinge === "none")) return;
  duoCounted = true;
  countUsage("duo_layout_shown");
}

export const forgetLandscapeCount = () => {
  counted = false;
  duoCounted = false;
};
