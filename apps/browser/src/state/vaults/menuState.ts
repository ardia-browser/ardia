import type { VaultField, VaultFieldKind, VaultFieldRect } from "../../platform/vaults";
import type { MenuMode } from "./menuModel";

type FrameId = VaultField["frameId"];

export type VaultTouchPhase = "off" | "ready" | "retry" | "granted" | "unavailable" | "lockout";

export type VaultMenu = {
  seq: number;
  tabId: string | null;
  frameId: FrameId;
  origin: string;
  field: VaultFieldKind;
  rect: VaultFieldRect | null;
  maxLength: number;
  mode: MenuMode;
  query: string;
  selected: number;
  selectedKey: string | null;
  onDemand: boolean;
  error: string | null;
  busy: string | null;
  hovered: boolean;
  hidden: boolean;
  noTotp: string[];
  remembered: string | null;
  email: boolean;
  suggestOpen: boolean;
  touch: VaultTouchPhase;
  touchRetries: number;
  touchRearms: number;
  profile: string | null;
  webauthn: boolean;
};
