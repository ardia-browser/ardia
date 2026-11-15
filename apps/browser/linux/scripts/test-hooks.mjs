import { registerHooks } from "node:module";


const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|json|node)$/;

const asModule = (resolved) => (resolved.url.startsWith("file:") && /\.ts(?:\?.*)?$/.test(resolved.url) ? { ...resolved, format: "module-typescript" } : resolved);

function resolveSource(specifier, context, next) {
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
}

registerHooks({
  resolve(specifier, context, next) {
    return asModule(resolveSource(specifier, context, next));
  },
});
