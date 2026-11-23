export type Tone = "default" | "secondary" | "tertiary" | "accent" | "success" | "warning" | "destructive";
export const TONES: readonly Tone[] = ["default", "secondary", "tertiary", "accent", "success", "warning", "destructive"];

type PluginNodeType = string;
export type PluginNode = { type: PluginNodeType; key?: string | number; props: Record<string, unknown>; children: (PluginNode | string)[] };

export type SurfaceKind = "sidebar" | "popover" | "panel" | "command";

export type QuickPickItem = { id: string; title: string; subtitle?: string; icon?: string; badge?: string; keywords?: string[]; picked?: boolean };
export type QuickPickOptions = { title?: string; placeholder?: string; canPickMany?: boolean };
export type InputBoxOptions = { title: string; message?: string; placeholder?: string; value?: string; password?: boolean; confirmTitle?: string };
export type ToolbarUpdate = { icon?: string; label?: string | null; badge?: string | number | boolean | null; tooltip?: string | null; tone?: Tone };

type SurfaceMountMessage = { surface: "mount"; surfaceId: string; viewId: string; kind: SurfaceKind; context?: Record<string, unknown> };
type SurfaceUnmountMessage = { surface: "unmount"; surfaceId: string };
type SurfaceEventMessage = { surface: "event"; surfaceId: string; handlerId: string; args: unknown[] };
export type SurfaceMessage = SurfaceMountMessage | SurfaceUnmountMessage | SurfaceEventMessage;
