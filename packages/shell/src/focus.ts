export type KeyHoldDrop = "modified" | "edit" | "character" | "dead" | "ime" | "mouse" | "window" | "command" | "cancelled" | "focus" | "reload" | "site" | "capacity" | "timeout";

export type KeyHoldCounts = { holds: number; replayed: number; drops: Partial<Record<KeyHoldDrop, number>> };

export type KeyHoldNative = { keyHoldCounts(): KeyHoldCounts };

export type FocusNative = {
  setSwitcherCapture(active: boolean): Promise<void>;
  takeEditKeyAcks?(): Record<string, number>;
  takeInputSourceKeys?(): number;
  setDragEscapeCapture(active: boolean): Promise<void>;
  cancelFocusMove(generation: number, restoringSource: boolean): Promise<void>;
  claimFocus(generation: number, tag: number): Promise<void>;
  saveKeyResponder(windowId: string): Promise<number>;
  restoreKeyResponder(token: number): Promise<boolean>;
  discardKeyResponder(token: number): Promise<void>;
  switcherPointerMoved(): boolean;
  pressesWithoutRelease(): number;
  takeFocusHandoffCounts?(): Record<string, Record<string, number>>;
  setConsentEpoch?(epoch: string): void;
  pressRepeated(): Promise<{ landedOn: string; ms: number } | null>;
};
