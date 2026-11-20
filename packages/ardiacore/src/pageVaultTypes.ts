import type { VaultItem } from "./vaults";

export type VaultFieldKind = "username" | "password" | "newPassword" | "otp";
export type VaultFieldRect = { x: number; y: number; width: number; height: number };
export type VaultFieldInset = { top: number; bottom: number; trailing: number };
export type VaultField = {
  frameId: string;
  origin: string;
  main: boolean;
  kind: VaultFieldKind;
  focused: boolean;
  rect: VaultFieldRect | null;
  formHasPassword: boolean;
  clicked?: boolean;
  auto?: boolean;
  maxLength?: number;
  email?: boolean;
  rtl?: boolean;
  darkField?: boolean | null;
  brandColor?: string | null;
  trailingTaken?: boolean;
  inset?: VaultFieldInset | null;
  webauthn?: boolean;
};
export type VaultKey = "ArrowDown" | "ArrowUp" | "Enter" | "Escape" | "Tab" | "Typed" | "Cleared";
export type VaultKeyPress = { frameId: string; key: VaultKey };
export type VaultUsernameSource = "form" | "step" | "page" | "nearby" | "";
export type VaultSubmission = {
  frameId: string;
  origin: string;
  username: string;
  newPassword: boolean;
  generated: boolean;
  usernameFrom: VaultUsernameSource;
  trusted: boolean;
  reportsOutcome?: boolean;
};
export type VaultLoginOutcome = { frameId: string; origin: string; ok: boolean };
export type VaultLoginPage = { frameId: string; origin: string; main: boolean };
export type VaultPasswordStyle = "strong" | "alphanumeric" | "easyToType" | "passphrase";
export type VaultFillField = "username" | "password" | "totp";
export type VaultFillError = "locked" | "originMismatch" | "insecure" | "notFound" | "failed" | "notAuthorized" | "offline";
export type VaultFillRequest = {
  frameId: string;
  origin: string;
  provider: string;
  id: string;
  fields: VaultFillField[];
  userChose?: boolean;
  submit?: boolean;
  target?: VaultFillTarget;
};
export type VaultFillTarget = "contextMenu";
export type VaultContextField = {
  frameId: string;
  origin: string;
  main: boolean;
  kind: VaultFieldKind | null;
  guess: VaultContextChoice;
  rect: VaultFieldRect | null;
  maxLength: number;
};
export type VaultContextChoice = "username" | "password" | "otp";
export type VaultContextAction =
  | { frameId: string; origin: string; action: "fill"; login: string; field: VaultContextChoice }
  | { frameId: string; origin: string; action: "generate"; style: VaultPasswordStyle }
  | { frameId: string; origin: string; action: "unlock" | "other" };
export type VaultContextLogin = { key: string; title: string; fields: VaultContextChoice[] };
export type VaultContextMenu = { logins: VaultContextLogin[]; unlock: boolean; other: boolean; note: string | null };
export type VaultCodeFound = { frameId: string; origin: string; main: boolean; rect: VaultFieldRect | null; token: string; issuer: string; account: string };
export type VaultCodeAction =
  | { frameId: string; origin: string; token: string; action: "save"; login: string }
  | { frameId: string; origin: string; token: string; action: "unlock" | "other" };
export type VaultCodeLogin = { key: string; title: string };
export type VaultCodeMenu = { logins: VaultCodeLogin[]; unlock: boolean; other: boolean; note: string | null };
export type VaultFillResult = { filled: VaultFieldKind[]; error?: VaultFillError };
export type VaultSaveRequest = { provider: string; origin: string; title?: string; username?: string };
export type VaultPasswordDraft = { token: string; length: number };
export type VaultSaveResult = { saved: boolean; item?: VaultItem; error?: string };
export type VaultUpdateRequest = { provider: string; id: string; origin: string };
