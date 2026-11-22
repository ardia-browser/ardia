import { t } from "./uiLanguage";
export type PermissionKind = "camera" | "microphone" | "location";

const ORDER: PermissionKind[] = ["camera", "microphone", "location"];

export const PERMISSION_NAMES: Record<PermissionKind, string> = { camera: t(`Camera`), microphone: t(`Microphone`), location: t(`Location`) };

export const sortedPermissions = (kinds: readonly PermissionKind[]): PermissionKind[] => ORDER.filter((kind) => kinds.includes(kind));

export function permissionSummary(kinds: readonly PermissionKind[]): string {
  const names = sortedPermissions(kinds).map((kind) => PERMISSION_NAMES[kind]);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
