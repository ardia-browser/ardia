import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizePath, type ModuleNode, type Plugin, type ViteDevServer } from "vite";

export const PIXEL_SCALES = [3, 2] as const;
const SCALED_PREFIX = "\0ardia-scaled:";
const SCALED_PNG = /@\d+x\.png$/;
const PNG_SIGNATURE = "89504e470d0a1a0a";

export type ScaledAsset = { file: string; scale: number; width: number; height: number };

export function pngSize(file: string) {
  const header = readFileSync(file).subarray(0, 24);
  if (header.length < 24 || header.subarray(0, 8).toString("hex") !== PNG_SIGNATURE || header.subarray(12, 16).toString("latin1") !== "IHDR") {
    throw new Error(`${file} is not a PNG`);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

export function scaledAsset(file: string): ScaledAsset | null {
  if (!file.endsWith(".png") || SCALED_PNG.test(file) || !existsSync(file)) return null;
  const stem = file.slice(0, -".png".length);
  for (const scale of PIXEL_SCALES) {
    const sibling = `${stem}@${scale}x.png`;
    if (existsSync(sibling)) return { file: sibling, scale, ...pngSize(file) };
  }
  return null;
}

export function scaledAssetModule(asset: ScaledAsset) {
  return [
    `import uri from ${JSON.stringify(asset.file)};`,
    `export default { uri, width: ${asset.width}, height: ${asset.height}, scale: ${asset.scale} };`,
  ].join("\n");
}

export function scaledSiblingBase(file: string) {
  const posix = normalizePath(file);
  return SCALED_PNG.test(posix) ? posix.replace(SCALED_PNG, ".png") : null;
}

function reloadScaledBase(server: ViteDevServer, file: string) {
  const base = scaledSiblingBase(file);
  if (!base) return;
  const graph = server.moduleGraph;
  const modules = [graph.getModuleById(SCALED_PREFIX + base), ...(graph.getModulesByFile(base) ?? [])].filter((mod): mod is ModuleNode => !!mod);
  if (!modules.length) return;
  const stale = new Set<ModuleNode>();
  for (const mod of modules) {
    stale.add(mod);
    for (const importer of mod.importers) stale.add(importer);
  }
  for (const mod of stale) graph.invalidateModule(mod);
  server.ws.send({ type: "full-reload" });
}

export function scaledAssets(name: string): Plugin {
  let server: ViteDevServer | undefined;
  const watched = new Set<string>();
  const watchFolderOf = (file: string) => {
    const folder = dirname(file);
    if (!server || watched.has(folder)) return;
    watched.add(folder);
    server.watcher.add(folder);
  };
  return {
    name,
    enforce: "pre",
    configureServer(dev) {
      server = dev;
      dev.watcher.on("add", (file) => reloadScaledBase(dev, file));
      dev.watcher.on("unlink", (file) => reloadScaledBase(dev, file));
    },
    async resolveId(source, importer, options) {
      if (!source.endsWith(".png") || importer?.startsWith(SCALED_PREFIX)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external || resolved.id.includes("?")) return null;
      watchFolderOf(resolved.id);
      return scaledAsset(resolved.id) ? SCALED_PREFIX + resolved.id : null;
    },
    load(id) {
      if (!id.startsWith(SCALED_PREFIX)) return null;
      const file = id.slice(SCALED_PREFIX.length);
      const asset = scaledAsset(file);
      if (!asset) this.error(`${file} lost its @2x/@3x sibling`);
      this.addWatchFile(file);
      this.addWatchFile(asset.file);
      return scaledAssetModule(asset);
    },
  };
}
