import { readdirSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { PIXEL_SCALES, pngSize, scaledAsset } from "../scaledAssets.ts";

export const BROWSER_ASSETS = fileURLToPath(new URL("../../browser/assets/", import.meta.url));
const HIDPI_PNG = /@\d+x\.png$/;

const browserPngs = () =>
  readdirSync(BROWSER_ASSETS, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".png"))
    .sort()
    .map((file) => join(BROWSER_ASSETS, file));

export const hiDpiBrowserPngs = () => browserPngs().filter((file) => HIDPI_PNG.test(file));

export const scaledBrowserAssets = () =>
  browserPngs().flatMap((base) => {
    const asset = scaledAsset(base);
    return asset ? [{ base, ...asset }] : [];
  });

export { PIXEL_SCALES, pngSize };

export async function bundledImages(root, config = {}) {
  const result = await build({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", ...config, build: { write: false } });
  const outputs = [result].flat().flatMap((bundle) => bundle.output);
  const emitted = outputs.filter((item) => item.type === "asset" && item.fileName.endsWith(".png")).map((item) => ({ fileName: item.fileName, bytes: Buffer.from(item.source) }));
  const code = outputs.filter((item) => item.type === "chunk").map((item) => item.code).join("\n");
  const holds = (file) => {
    const bytes = readFileSync(file);
    return emitted.some((item) => item.bytes.equals(bytes)) || code.includes(bytes.toString("base64"));
  };
  return { emitted, holds, fileNames: outputs.map((item) => item.fileName) };
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const rows = [];
  let previous = new Uint8Array(stride);
  for (let y = 0, at = 0; y < height; y++) {
    const filter = raw[at++];
    const line = Uint8Array.from(raw.subarray(at, at + stride));
    at += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const corner = x >= channels ? previous[x - channels] : 0;
      const guess = left + up - corner;
      const nearest = Math.abs(guess - left) <= Math.abs(guess - up) && Math.abs(guess - left) <= Math.abs(guess - corner) ? left : Math.abs(guess - up) <= Math.abs(guess - corner) ? up : corner;
      const predicted = [0, left, up, (left + up) >> 1, nearest][filter];
      line[x] = (line[x] + predicted) & 255;
    }
    rows.push(line);
    previous = line;
  }
  return rows;
}

export function pngAlpha(file) {
  const bytes = readFileSync(file);
  const { width, height } = pngSize(file);
  const [depth, color, , , interlace] = bytes.subarray(24, 29);
  const channels = CHANNELS[color];
  if (depth !== 8 || interlace !== 0 || !channels) throw new Error(`${file} is not an 8-bit non-interlaced grey or RGB PNG`);
  const data = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    if (bytes.subarray(at + 4, at + 8).toString("latin1") === "IDAT") data.push(bytes.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const rows = unfilter(inflateSync(Buffer.concat(data)), width, height, channels);
  const hasAlpha = color === 4 || color === 6;
  return { width, height, at: (x, y) => (hasAlpha ? rows[y][x * channels + channels - 1] : 255) };
}

export function alphaDrift(base, hiRes, scale) {
  const low = pngAlpha(base);
  const high = pngAlpha(hiRes);
  let total = 0;
  for (let y = 0; y < low.height; y++) {
    for (let x = 0; x < low.width; x++) {
      let sum = 0;
      for (let j = 0; j < scale; j++) for (let i = 0; i < scale; i++) sum += high.at(x * scale + i, y * scale + j);
      total += Math.abs(low.at(x, y) - sum / (scale * scale));
    }
  }
  return total / (low.width * low.height);
}
