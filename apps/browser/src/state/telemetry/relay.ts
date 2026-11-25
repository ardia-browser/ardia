import type { ConsentToken } from "./choice";

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

type TelemetryRelay = {
  capture(event: string, props: Record<string, unknown>, consent: ConsentToken | null, options: CaptureOptions): boolean;
  log(level: "warn" | "error", message: string, attributes: Record<string, string | number | boolean>, consent: ConsentToken | null): void;
  resetId(): Promise<string>;
  change(change: ChoiceChange): Promise<boolean>;
  installId(): string;
};

let relay: TelemetryRelay | null = null;

export const telemetryRelay = () => relay;
const relayReady = new Set<() => void>();

export const onTelemetryRelay = (listener: () => void) => void relayReady.add(listener);

export function setTelemetryRelay(next: TelemetryRelay | null) {
  relay = next;
  if (next) for (const listener of relayReady) listener();
}
