import { readFileSync } from "node:fs";
import sharp from "sharp";
import { COLOURS, FACTS, LONG, SHORT, SHOTS, SITE, ZIP_NAME, colour } from "../data/press";
import { zip } from "./zip";

const repoRoot = `${process.cwd()}/../..`;
const siteRoot = process.cwd();

const markSource = readFileSync(`${siteRoot}/src/assets/ardia-mark.svg`, "utf8");
const markBox = markSource.match(/viewBox="([^"]+)"/)![1]!;
const markPath = (id: string) => markSource.match(new RegExp(`<path id="${id}" d="([^"]+)"`))![1]!;

const oneColourMark = (fill: string) => {
  const [x, y, width, height] = markBox.split(" ");
  const seam = `<mask id="seam" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${width}" height="${height}"><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#fff"/><path d="${markPath("front")}" fill="#000" stroke="#000" stroke-width="44" stroke-linejoin="round"/></mask>`;
  return markSource
    .replace(/<path id="back" d="([^"]+)" fill="[^"]+"\/>/, `<defs>${seam}</defs><path id="back" d="$1" fill="${fill}" mask="url(#seam)"/>`)
    .replace(/fill="#[0-9A-Fa-f]{6}"/g, `fill="${fill}"`);
};

export const MARK_SVGS: Record<string, string> = {
  "mark-colour": markSource,
  "mark-black": oneColourMark(colour("Ink")),
  "mark-white": oneColourMark("#FFFFFF"),
};

const svgToPng = (svg: string) => sharp(Buffer.from(svg), { density: 144 }).resize({ width: 2048 }).png({ compressionLevel: 9 }).toBuffer();

const builders: Record<string, () => Promise<Buffer> | Buffer> = {
  "ardia-app-icon.png": () =>
    readFileSync(`${repoRoot}/apps/browser/macos/Ardia-macOS/Assets.xcassets/AppIcon.appiconset/icon_512x512_2x.png`),
  "ardia-mark-painted.png": () =>
    sharp(`${siteRoot}/src/assets/ardia-mark.png`).trim({ threshold: 16 }).png({ compressionLevel: 9 }).toBuffer(),
  ...Object.fromEntries(
    Object.entries(MARK_SVGS).flatMap(([id, svg]) => [
      [`ardia-${id}.svg`, () => Buffer.from(svg)],
      [`ardia-${id}.png`, () => svgToPng(svg)],
    ]),
  ),
  ...Object.fromEntries(
    SHOTS.map(({ id }) => [
      `ardia-screenshot-${id}.jpg`,
      () => sharp(`${siteRoot}/src/assets/shots/${id}.webp`).jpeg({ quality: 92, mozjpeg: true }).toBuffer(),
    ]),
  ),
};

export const PRESS_FILES = Object.keys(builders);

const built = new Map<string, Promise<Buffer>>();
export const pressFile = (name: string) => {
  if (!built.has(name)) built.set(name, Promise.resolve(builders[name]!()));
  return built.get(name)!;
};

const readme = () =>
  [
    "Ardia press kit",
    "",
    SHORT,
    "",
    LONG,
    "",
    ...FACTS.map((f) => `${f.term}: ${f.href ?? f.value}`),
    "",
    "Colors",
    ...COLOURS.map((c) => `${c.name} ${c.hex}: ${c.use}`),
    "",
    "Use the logos as they are: no redrawing, recoloring, stretching or effects.",
    "Ardia isn’t affiliated with Google or The Browser Company. Arc, Dia and Chrome are their trademarks.",
    `More at https://${SITE}/press`,
    "",
  ].join("\n");

const zipEntryPath = (name: string) =>
  name.startsWith("ardia-screenshot-") ? `screenshots/${name}` : `logo/${name}`;

let kit: Promise<Buffer> | undefined;
export const pressZip = () =>
  (kit ??= Promise.all(PRESS_FILES.map(async (name) => ({ path: zipEntryPath(name), data: await pressFile(name) }))).then(
    (files) => zip(ZIP_NAME.replace(/\.zip$/, ""), [{ path: "README.txt", data: Buffer.from(readme(), "utf8") }, ...files]),
  ));
