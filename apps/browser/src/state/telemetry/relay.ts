export type CaptureOptions = {
  raw?: Record<string, unknown>;
  urgent?: boolean;
  persist?: boolean;
};

export type SharingSource = "settings" | "onboarding" | "ask" | "watch" | "watch_ended";

export type AskPlacement = { ask_place: "new_tab_corner"; ask_shown_tabs: number };

export type ChoiceChange =
  | { kind: "sharing"; on: boolean; source: SharingSource; placement?: AskPlacement }
  | { kind: "askDismissed" }
  | { kind: "watchStarted"; reportId: string; days: number }
  | { kind: "watchStopped" }
  | { kind: "watchNoticeShown" }
  | { kind: "installId"; id: string };

export type TelemetryRelay = {
  capture(event: string, props: Record<string, unknown>, options: CaptureOptions): void;
  log(level: "warn" | "error", message: string, attributes: Record<string, string | number | boolean>): void;
  resetId(): Promise<string>;
  change(change: ChoiceChange): void;
  installId(): string;
};

let relay: TelemetryRelay | null = null;

export const telemetryRelay = () => relay;
export const setTelemetryRelay = (next: TelemetryRelay | null) => void (relay = next);
