import { NATIVE_GLASS_PLATFORM } from "@platform/nativeGlass";
import type { ArdiaHost } from "./host";

type CanvasMaker = () => Pick<HTMLCanvasElement, "getContext">;

export const nativeLiquidGlass = (host: Pick<ArdiaHost, "bootstrap"> | null | undefined) => host?.bootstrap.nativeModules?.ArdiaGlassEffect?.isLiquidGlass === true;

let webLiquidGlass: boolean | undefined;

export function probeWebLiquidGlass(makeCanvas: CanvasMaker) {
  try {
    const gl = makeCanvas().getContext("webgl2") as WebGL2RenderingContext | null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

export function webLiquidGlassSupported() {
  if (typeof document === "undefined") return false;
  webLiquidGlass ??= probeWebLiquidGlass(() => document.createElement("canvas"));
  return webLiquidGlass;
}

export const webLiquidGlassAllowed = (host: Pick<ArdiaHost, "bootstrap"> | null | undefined, nativePlatform = NATIVE_GLASS_PLATFORM) =>
  nativePlatform ? host?.bootstrap.nativeModules?.ArdiaGlassEffect?.isLiquidGlass === false : !nativeLiquidGlass(host);

export const glassAppearanceSupported = (host: Pick<ArdiaHost, "bootstrap"> | null | undefined, webSupported: () => boolean = webLiquidGlassSupported, nativePlatform = NATIVE_GLASS_PLATFORM) =>
  nativeLiquidGlass(host) || (webLiquidGlassAllowed(host, nativePlatform) && webSupported());
