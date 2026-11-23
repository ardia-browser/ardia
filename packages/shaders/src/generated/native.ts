export type MetalSurfaceSnapshot = { file: string; class: string; ok: boolean; window: number; frame: [number, number, number, number]; key: boolean; main: boolean; drawable: [number, number]; hidden: boolean; alpha: number };

export type AreaLightNative = {
  debugSnapshot(dir: string): Promise<MetalSurfaceSnapshot[]>;
};

export type WindowBackdropNative = {
  holdKeyLook(on: boolean): Promise<void>;
};

export type MeadowNative = {
  debugState(): Promise<Record<string, unknown>>;
  debugEval(script: string): Promise<unknown>;
};

export type ShadersModules = {
  ArdiaAreaLight: AreaLightNative;
  ArdiaWindowBackdrop: WindowBackdropNative;
  ArdiaMeadow: MeadowNative;
};
