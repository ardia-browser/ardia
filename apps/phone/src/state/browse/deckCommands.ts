import { create } from "zustand";

export type DeckCommand = { kind: "scroll"; index: number } | { kind: "closeFocused" } | { kind: "openFocused" } | { kind: "openSelected" } | { kind: "lift"; offset: number } | { kind: "showArchiveCard" };

type Sent = DeckCommand & { id: number };

export const useDeckCommand = create<{ command: Sent | null }>()(() => ({ command: null }));

let next = 0;

export const sendDeckCommand = (command: DeckCommand) => useDeckCommand.setState({ command: { ...command, id: ++next } as Sent });

export const takeDeckCommand = (id: number) => {
  if (useDeckCommand.getState().command?.id === id) useDeckCommand.setState({ command: null });
};
