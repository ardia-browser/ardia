const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [path.resolve(repoRoot, "packages/phone"), path.resolve(repoRoot, "packages/core")];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
config.resolver.disableHierarchicalLookup = true;
config.transformer.getTransformOptions = async () => ({ transform: { experimentalImportSupport: true, inlineRequires: true } });
config.cacheVersion = [config.cacheVersion, process.env.EXPO_PUBLIC_ARDIA_LAB === "true" ? "lab" : "store"].join(":");

const steppedWindow = path.resolve(projectRoot, "src/lib/steppedWindow.ts");
const expoUiRecycling = `${path.sep}@expo${path.sep}ui${path.sep}build${path.sep}recycling${path.sep}`;
const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "ios" && moduleName === "./window" && context.originModulePath.includes(expoUiRecycling)) return { type: "sourceFile", filePath: steppedWindow };
  return upstreamResolve ? upstreamResolve(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
