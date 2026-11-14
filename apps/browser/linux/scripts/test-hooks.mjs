import { registerHooks } from "node:module";

const fakeElectron = new URL("../src/testing/electron.ts", import.meta.url).href;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|json|node)$/;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron") return { url: fakeElectron, format: "module", shortCircuit: true };
    try {
      return next(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || SOURCE_EXTENSION.test(specifier)) throw error;
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        return next(`${specifier}/index.ts`, context);
      }
    }
  },
});
