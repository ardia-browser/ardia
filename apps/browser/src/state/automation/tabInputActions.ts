export const INPUT_ACTIONS = ["click", "dblclick", "move", "down", "up", "wheel", "key", "text"] as const;
export type InputAction = (typeof INPUT_ACTIONS)[number];
