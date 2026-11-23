import "../../browser/src/test-loader.mjs";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { desktopMode, platformSuffixes } from "../desktopModes.ts";

const native = new URL("./host-test-native.mjs", import.meta.url).href;
const platformDir = new URL("../src/platform/", import.meta.url);
const twins = platformSuffixes(desktopMode(process.env.ARDIA_DESKTOP_MODE ?? "linux")).flatMap((suffix) => [`${suffix}.ts`, `${suffix}.tsx`]);
const PLATFORM_PREFIX = "@platform/";

function platformSeam(specifier) {
  const name = specifier.slice(PLATFORM_PREFIX.length);
  const found = twins.map((twin) => new URL(`${name}${twin}`, platformDir)).find((url) => existsSync(url));
  if (!found) throw new Error(`${specifier} has no ${twins.map((twin) => `${name}${twin}`).join(" or ")} in src/platform`);
  return found.href;
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "react-native") return { url: native, shortCircuit: true };
    if (specifier.startsWith(PLATFORM_PREFIX)) return { url: platformSeam(specifier), shortCircuit: true };
    return next(specifier, context);
  },
});
