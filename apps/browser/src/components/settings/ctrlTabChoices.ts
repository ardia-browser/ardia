import type { CtrlTabPreset } from "../../state/commands/ctrlTabKeys";

export const CTRL_TAB_CHOICES: readonly { value: CtrlTabPreset; title: string; caption: string }[] = [
  { value: "step", title: "Step through tabs", caption: "Goes one tab down the list, like Chrome." },
  { value: "switcher", title: "Recent tabs switcher", caption: "Shows recent tabs; let go to switch, like Arc." },
];
