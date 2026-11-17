import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { startBrowser } from "../lib/flows.mjs";
import { decodePng, distinctColors, hasPngSignature, minimumAlpha } from "../lib/png.mjs";
import { sessionSeed } from "../lib/seed.mjs";
import { until } from "../lib/util.mjs";

const PAGE = "data:text/html,<title>Window snapshot</title><body style=\"margin:0;background:%23ff00ff\"></body>";
const nearMagenta = (pixels, at) => pixels[at] > 247 && pixels[at + 1] < 8 && pixels[at + 2] > 247 && pixels[at + 3] === 255;

function magentaShare({ width, height, pixels }) {
  let count = 0;
  for (let at = 0; at < width * height * 4; at += 4) if (nearMagenta(pixels, at)) count++;
  return count / (width * height);
}

export default {
  id: "F29",
  issue: 2238,
  title: "ArdiaApp.devSnapshotWindow writes the whole window, shell and page, to a PNG in an isolated instance",
  deadline: 240000,
  manual: [
    { name: "A covered or off-screen window", steps: ["Launch an isolated instance on a desktop, cover its window with another one or move it off screen, then call ArdiaApp.devSnapshotWindow(windowId, '/abs/out.png').", "The PNG still shows the sidebar, toolbar and page: the picture comes from the compositor, not the screen."], reason: "the suite's headless window has no screen to cover" },
    { name: "A regular launch does not offer the hook", steps: ["Start Ardia with neither --user-data-dir nor ARDIA_DATA_DIR and call ArdiaApp.devSnapshotWindow from the shell's console.", "It rejects with ERR_UNAVAILABLE, as before."], reason: "every scenario launch is isolated" },
  ],
  async run(t) {
    const { app, shell } = await startBrowser(t, { name: "snapshot", session: sessionSeed({ windows: [{ id: "main", urls: [PAGE] }] }) });
    await mkdir(t.evidenceDir, { recursive: true });
    const file = (name) => join(t.evidenceDir, `${name}.png`);
    const answer = async (path, options) => {
      const reply = await shell.snapshotWindow(path, options);
      if (!reply.ok) throw new Error(`devSnapshotWindow was refused: ${reply.code ?? ""} ${reply.message}`);
      return reply.value;
    };

    let picture;
    await t.check("the isolated instance offers the hook and the picture holds the page, not a hole", async () => {
      const path = file("window");
      picture = await until(async () => {
        if ((await answer(path)) !== true) return false;
        const decoded = decodePng(await readFile(path));
        return magentaShare(decoded) > 0.1 ? decoded : false;
      }, { timeout: 30000, interval: 500, label: "a snapshot whose page area shows the page", abort: () => app.exitReason() });
      return { width: picture.width, height: picture.height, pageShare: magentaShare(picture) };
    }, { critical: true });

    await t.check("the file is a PNG about the size of the window", async () => {
      const bytes = await readFile(file("window"));
      if (!hasPngSignature(bytes)) throw new Error("the file does not start with the PNG signature");
      const view = await shell.eval("({ width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio })");
      for (const side of ["width", "height"]) {
        if (picture[side] < view[side] - 2 || picture[side] > view[side] * 1.1) throw new Error(`the picture's ${side} is ${picture[side]} px and the shell viewport's is ${view[side]} px`);
      }
      return { picture: [picture.width, picture.height], viewport: [view.width, view.height], bytes: bytes.length };
    });

    await t.check("the sidebar is drawn in the picture, not left blank", async () => {
      const strip = { x: 0, y: 0, w: Math.min(120, Math.floor(picture.width / 8)), h: picture.height };
      const colours = distinctColors(picture, strip);
      if (colours < 3) throw new Error(`the strip ${JSON.stringify(strip)} on the sidebar's side holds ${colours} colour(s)`);
      return { strip, colours };
    });

    await t.check("with transparent false the picture is filled opaque", async () => {
      const path = file("window-opaque");
      if ((await answer(path, { transparent: false })) !== true) throw new Error("devSnapshotWindow answered false");
      const alpha = minimumAlpha(decodePng(await readFile(path)));
      if (alpha !== 255) throw new Error(`the least alpha in an opaque snapshot is ${alpha}`);
      return { alpha };
    });

    await t.check("with transparent true the hook answers true and writes a PNG", async () => {
      const path = file("window-transparent");
      if ((await answer(path, { transparent: true })) !== true) throw new Error("devSnapshotWindow answered false");
      const decoded = decodePng(await readFile(path));
      return { width: decoded.width, height: decoded.height, leastAlpha: minimumAlpha(decoded) };
    });

    await t.check("a relative path, an unknown window and an unwritable directory answer false", async () => {
      const missing = join(t.evidenceDir, "no-such-directory", "out.png");
      const relative = await answer("relative.png");
      const unwritable = await answer(missing);
      const unknown = await shell.invoke("ArdiaApp.devSnapshotWindow", { args: ["no-such-window", file("unknown")] });
      if (relative !== false) throw new Error(`a relative path answered ${relative}`);
      if (unwritable !== false) throw new Error(`an unwritable directory answered ${unwritable}`);
      if (!unknown.ok || unknown.value !== false) throw new Error(`an unknown window answered ${JSON.stringify(unknown)}`);
      await rm(file("unknown"), { force: true });
      return { relative, unwritable, unknown: unknown.value };
    });
  },
};
