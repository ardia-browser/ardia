#!/usr/bin/env node
const HELP = `Builds the onboarding intro's meadow from ardia.dev's hero scene.

  node scripts/meadow.mjs           write ios/Meadow (index.html, posters.json and the posters) and windows/meadow/page.ts
  node scripts/meadow.mjs --check   fail if either differs from what the site's sources build

The page runs apps/site/src/scripts/meadowApp.ts, which starts the site's own createMeadow and
startSunrise (apps/site/src/scripts/meadow), bundled inline so the pod ships one HTML file. The
posters are the site's desktop dawn and morning frames from apps/site/src/data/heroPoster.ts; the
native view shows the one nearest the window's shape until the scene's first frame.

windows/meadow/page.ts is the same page for the Windows intro, which runs it as an engine page. The
page itself has no text and no scripts: the app opens it as a small data: URL (its two halves are
base64 of whole 3-byte groups, joined around the config and first-paint style the app writes into its
head), then adds MEADOW_PAGE_SCRIPT, which is src/meadowPage/shim.ts (it draws the app's icon,
wordmark, tagline, Skip and Mute from that config, and carries the app icon) followed by the scene.
Images load only from data: URLs; the dawn posters come as data: URLs too.`;

import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}
const check = args.includes("--check");

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const site = join(repo, "apps/site/src");
const out = fileURLToPath(new URL("../ios/Meadow/", import.meta.url));
const windowsPage = fileURLToPath(new URL("../windows/meadow/page.ts", import.meta.url));
const shim = fileURLToPath(new URL("../src/meadowPage/shim.ts", import.meta.url));
const appIcon = join(repo, "apps/browser/assets/app-icon.png");
const posterDir = join(site, "assets/hero");
const DESKTOP_FRAMES = new Set(["wider", "wide", "laptop", "mid"]);

async function bundle(entry, options) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    logLevel: "silent",
    legalComments: "none",
    tsconfigRaw: { compilerOptions: { target: "ESNext", verbatimModuleSyntax: true, strict: true } },
    ...options,
  });
  return result.outputFiles[0].text;
}

async function heroPosters() {
  const globShim = join(mkdtempSync(join(tmpdir(), "meadow-")), "glob.mjs");
  writeFileSync(
    globShim,
    `export const __glob = () => Object.fromEntries(${JSON.stringify(readdirSync(posterDir).filter((file) => file.endsWith(".webp")))}.map((file) => ["../assets/hero/" + file, file]));\n`,
  );
  const code = await bundle(join(site, "data/heroPoster.ts"), { format: "esm", platform: "node", define: { "import.meta.glob": "__glob" }, inject: [globShim] });
  const module = join(globShim, "../heroPoster.mjs");
  writeFileSync(module, code);
  const { HERO_POSTERS } = await import(pathToFileURL(module).href);
  rmSync(join(globShim, ".."), { recursive: true, force: true });
  return HERO_POSTERS.map((poster) => {
    const [state, frame] = poster.key.split("-");
    return { state, frame, file: poster.src, aspect: poster.width / poster.height, horizon: Number.parseFloat(poster.horizon) / 100 };
  }).filter((poster) => DESKTOP_FRAMES.has(poster.frame));
}

const STYLE = `html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
.hero{position:absolute;inset:0;overflow:hidden}
.meadow-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.hero-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.hero-title{display:flex;flex-direction:column;align-items:center;gap:18px;margin:0;color:transparent;font-family:-apple-system,system-ui,sans-serif;font-weight:normal}
.line{display:block}
.line>span{display:block}
.icon{width:96px;height:96px}
.wordmark{font-size:64px;font-weight:200;letter-spacing:-1.5px}
.tagline{font-size:17px;font-weight:300}`;

const MAC_LOOK = {
  csp: "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
  body: ' aria-hidden="true"',
  title: '<span class="line"><span class="icon"></span></span><span class="line"><span class="wordmark">Ardia</span></span><span class="line"><span class="tagline">Your new home on the internet</span></span>',
  shim: "",
  scripts: true,
};

function page(script, look = MAC_LOOK) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${look.csp}">
<style>${STYLE}</style>
</head>
<body${look.body}>
<section class="hero" data-meadow>
<canvas class="meadow-canvas" data-meadow-canvas></canvas>
<div class="hero-text"><div class="hero-title">${look.title}</div></div>
</section>
${look.scripts === false ? "" : `${look.shim}<script>${script.trim()}</script>\n`}</body>
</html>
`;
}

const inThrees = (text) => {
  const bytes = Buffer.from(text);
  return Buffer.concat([bytes, Buffer.alloc((3 - (bytes.length % 3)) % 3, "\n")]).toString("base64");
};

async function windowsPageModule(script, posters) {
  const icon = `data:image/png;base64,${readFileSync(appIcon).toString("base64")}`;
  const shimScript = (await bundle(shim, { format: "iife", platform: "browser", target: "chrome120", minify: true, define: { MEADOW_ICON: JSON.stringify(icon) } })).trim();
  if (shimScript.includes("</script")) throw new Error("the meadow shim can't hold </script");
  const html = page(script, {
    csp: "default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    body: "",
    title: "",
    shim: "",
    scripts: false,
  });
  const split = html.indexOf("</head>");
  const dawn = posters
    .filter((poster) => poster.state === "dawn")
    .map(({ file, aspect, horizon }) => ({ file, aspect, horizon, uri: `data:image/webp;base64,${readFileSync(join(posterDir, file)).toString("base64")}` }));
  return [
    `export const MEADOW_PAGE_HEAD = ${JSON.stringify(inThrees(html.slice(0, split)))};`,
    `export const MEADOW_PAGE_BODY = ${JSON.stringify(inThrees(html.slice(split)))};`,
    `export const MEADOW_PAGE_SCRIPT = ${JSON.stringify(`${shimScript}\n;\n${script.trim()}`)};`,
    `export const MEADOW_POSTERS = ${JSON.stringify(dawn)};`,
    "",
  ].join("\n");
}

async function generate() {
  const script = await bundle(join(site, "scripts/meadowApp.ts"), {
    format: "iife",
    platform: "browser",
    target: "safari17",
    minify: true,
    define: { "import.meta.env.DEV": "false" },
  });
  const posters = await heroPosters();
  const files = new Map([
    ["index.html", Buffer.from(page(script))],
    ["posters.json", Buffer.from(`${JSON.stringify(posters, null, 2)}\n`)],
  ]);
  for (const poster of posters) files.set(poster.file, readFileSync(join(posterDir, poster.file)));
  return { files, windows: Buffer.from(await windowsPageModule(script, posters)) };
}

const { files, windows } = await generate();
if (check) {
  const present = (() => {
    try {
      return readdirSync(out);
    } catch {
      return [];
    }
  })();
  const differs = (path, bytes) => {
    try {
      return !readFileSync(path).equals(bytes);
    } catch {
      return true;
    }
  };
  const stale = [...files].filter(([name, bytes]) => differs(join(out, name), bytes)).map(([name]) => name);
  if (differs(windowsPage, windows)) stale.push("windows/meadow/page.ts");
  const extra = present.filter((name) => !files.has(name));
  if (stale.length || extra.length) {
    console.error(`packages/shaders/ios/Meadow or windows/meadow/page.ts is out of date (${[...stale, ...extra].join(", ")}): run node packages/shaders/scripts/meadow.mjs`);
    process.exit(1);
  }
  console.log(`✓ ios/Meadow and windows/meadow/page.ts match the site's meadow (${files.size + 1} files)`);
} else {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [name, bytes] of files) writeFileSync(join(out, name), bytes);
  writeFileSync(windowsPage, windows);
  console.log(`wrote ${files.size} files to packages/shaders/ios/Meadow and windows/meadow/page.ts`);
}
