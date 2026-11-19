import { hostCall } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { LOAD_MS, SETTLE_MS, origin, port } from "./engineAutoplayKit";
import { LEFT, evaluate, firstWindow, listed, pause, show, until } from "./engineSleep";
import { FRAME_TITLE, TITLE, downloaded, expectPng, isPlaying, playFrame, reported, reportsOf, startPlaying, testPort, withReports, type Image, type Reports } from "./engineNowPlayingKit";

const ROTATIONS = 10;
const DOWNLOADS_SETTLE_MS = 15000;
const LONGEST_REPORTED_ARTWORK = 2048;
const PROBE_SETTLES_MS = 1500;
const OWN_LOAD_MS = 3000;
const REFUSED_DOWNLOAD_MS = 8000;
const COUNT_PAGE = "self-check-np-art-count";
const DATA_SVG_PREFIX = "data:image/svg+xml;base64,";

const artHits = async (key: string, reset = false) => Number(await evaluate(key, `fetch("/art-hits${reset ? "?reset" : ""}", { cache: "no-store" }).then((r) => r.text()).then((t) => post("result", JSON.stringify(Number(t))));`));

type ArtRequest = { kind: string; site: string; cookie: string };

async function artRequests(key: string): Promise<ArtRequest[]> {
  const seen = await evaluate(key, 'fetch("/art-cookies?reset", { cache: "no-store" }).then((r) => r.text()).then((t) => post("result", JSON.stringify(t)));');
  if (typeof seen !== "string") throw new Error(`the page server's record of artwork requests could not be read (${JSON.stringify(seen)})`);
  return seen
    .split("|")
    .filter(Boolean)
    .map((entry) => {
      const first = entry.indexOf(" ");
      const second = entry.indexOf(" ", first + 1);
      return { kind: entry.slice(0, first), site: entry.slice(first + 1, second), cookie: entry.slice(second + 1) };
    });
}

async function setCookies(key: string, windowId: string) {
  for (const host of ["127.0.0.1", "localhost"]) {
    const page = `self-check-np-cookie-${host}`;
    try {
      await hostCall("tab.create", { key: page, url: `http://${host}:${port}/set-cookie`, profile: "" }, windowId);
      await until(`the cookie page on ${host} loads`, LOAD_MS, () => listed(page), (tab) => tab?.title === "cookie set" && tab.loading === false);
      await evaluate(page, 'fetch("/art-cookie.png", { cache: "no-store" }).then(() => post("result", "true"), () => post("result", "false"));');
    } finally {
      await hostCall("tab.close", { key: page }).catch(() => null);
    }
  }
  const firstParty = await artRequests(key);
  expectTrue(firstParty.length === 2 && firstParty.every((request) => request.cookie.includes("np")), `each host now has a cookie its own pages send with a request for the artwork (${JSON.stringify(firstParty)})`);
}

async function sentAsTheFrame(key: string, probe: string, what: string, download: () => Promise<void>) {
  await artRequests(key);
  await evaluate(key, `${probe}.postMessage("np-probe", "*"); post("result", "true");`);
  const own = await until(`${what}: the frame's own image request arrives`, SETTLE_MS, () => artRequests(key), (requests) => requests.some((request) => request.kind === "probe"));
  const frame = own.find((request) => request.kind === "probe")!;
  await download();
  await pause(PROBE_SETTLES_MS);
  const requests = [...own.filter((request) => request.kind === "art"), ...(await artRequests(key))].filter((request) => request.kind === "art");
  console.info(`[ardia windows] self-check note: artwork requests for ${what}: the frame's own image ${JSON.stringify(frame)}, the artwork ${JSON.stringify(requests)}`);
  expectTrue(requests.length > 0, `${what}: the artwork request reached the server (${JSON.stringify(requests)})`);
  expectEqual(
    requests.filter((request) => request.site !== frame.site || request.cookie !== frame.cookie),
    [],
    `${what}: every artwork request carries the Sec-Fetch-Site (${frame.site}) and the cookies (${frame.cookie}) the frame's own image request did`,
  );
  expectEqual(requests.filter((request) => request.site === "none").length, 0, `${what}: no artwork request came from the browser itself (Sec-Fetch-Site: none)`);
}

async function artCounts(windowId: string, reset = false) {
  try {
    await hostCall("tab.create", { key: COUNT_PAGE, url: `${origin}/a`, profile: "" }, windowId);
    await until("the artwork count page loads", LOAD_MS, () => listed(COUNT_PAGE), (tab) => tab?.title === "loaded a" && tab.loading === false);
    const counts = await evaluate(COUNT_PAGE, `fetch("/art-count${reset ? "?reset" : ""}", { cache: "no-store" }).then((r) => r.text()).then((t) => post("result", JSON.stringify(t)));`);
    return JSON.parse(typeof counts === "string" ? counts : "{}") as Record<string, number>;
  } finally {
    await hostCall("tab.close", { key: COUNT_PAGE }).catch(() => null);
  }
}

const ownImage = (key: string, url: string) =>
  evaluate(key, `const probe = new Image(); const done = (result) => post("result", JSON.stringify(result)); probe.onload = () => done("loaded"); probe.onerror = () => done("error"); setTimeout(() => done("pending"), ${OWN_LOAD_MS}); probe.src = ${JSON.stringify(`${url}?probe`)};`);

const downloadedWithin = (key: string, url: string) => Promise.race([downloaded(key, url).catch(() => null), pause(REFUSED_DOWNLOAD_MS).then(() => "no answer" as const)]);

async function withOtherOrigin(name: string, url: string, run: (key: string, reports: Reports, windowId: string) => Promise<void>) {
  const key = `self-check-autoplay-${name}`;
  const reports = reportsOf(key);
  const windowId = await firstWindow();
  try {
    await hostCall("tab.create", { key, url, profile: "" }, windowId);
    await show(key, windowId, LEFT);
    await until(`the page ${key} loads`, LOAD_MS, () => listed(key), (tab) => tab?.title === TITLE && tab.loading === false);
    await run(key, reports, windowId);
  } finally {
    reports.stop();
    await hostCall("tab.close", { key }).catch(() => null);
  }
}

async function refusedLikeTheFrame(key: string, reports: Reports, windowId: string, name: string, what: string) {
  await startPlaying(key);
  const state = await reported(reports, `${what}: the page reports its artwork`, (now) => isPlaying(now) && !!now?.artwork?.endsWith(name));
  await artCounts(windowId, true);
  const own = await ownImage(key, state!.artwork!);
  const image = await downloadedWithin(key, state!.artwork!);
  await pause(PROBE_SETTLES_MS);
  const counts = await artCounts(windowId);
  const fetched = counts[name] ?? 0;
  const probed = counts[`${name}?probe`] ?? 0;
  console.info(`[ardia windows] self-check note: ${what}: the frame's own image ${JSON.stringify(own)} (${probed} reached the server over http), the artwork download ${JSON.stringify(typeof image === "object" && image ? { uri: image.uri ? "an image" : null } : image)} (${fetched} reached the server over http)`);
  if (own !== "loaded") {
    expectEqual({ image: typeof image === "object" && image?.uri ? "an image" : null, fetched }, { image: null, fetched: 0 }, `${what}: the frame may not load it (${JSON.stringify(own)}), so the artwork is not fetched either`);
  }
  return { own, fetched, image };
}

const artworkChecks: Check[] = [
  {
    name: "engine now playing: artwork, from the page and from a cross-site iframe, is fetched in the declaring frame's own context, with the cookies and Sec-Fetch-Site the frame's own image request carries",
    run: async () => {
      await withReports("np-cookie-main", "nowplaying?cookieart", TITLE, async (key, reports, windowId) => {
        await setCookies(key, windowId);
        await startPlaying(key);
        const state = await reported(reports, "the page reports its cookie artwork", (now) => isPlaying(now) && !!now?.artwork?.endsWith("/art-cookie.png"));
        await sentAsTheFrame(key, "window", "the page's artwork", async () => expectPng(await downloaded(key, state!.artwork!), "the page's artwork"));
      });
      await withReports("np-cookie-frame", "npframe?cookieart", FRAME_TITLE, async (key, reports, windowId) => {
        await playFrame(key, windowId);
        const state = await reported(reports, "the iframe reports its cookie artwork", (now) => isPlaying(now) && !!now?.artwork?.endsWith("/art-cookie.png"));
        await sentAsTheFrame(key, 'document.querySelector("iframe").contentWindow', "the cross-site iframe's artwork", async () => expectPng(await downloaded(key, state!.artwork!), "the cross-site iframe's artwork"));
      });
    },
  },
  {
    name: "engine now playing: an artwork image over 2 MiB, which the frame's own image downloader reads, arrives within the size asked for",
    run: () =>
      withReports("np-big-art", "nowplaying?bigart", TITLE, async (key, reports) => {
        await startPlaying(key);
        const state = await reported(reports, "the page reports its large artwork", (now) => isPlaying(now) && !!now?.artwork?.endsWith("/art-big.png"));
        expectPng(await downloaded(key, state!.artwork!), "a valid 3 MiB PNG");
      }),
  },
  {
    name: "engine now playing: artwork rotated ten times quickly answers every download, and only the newest artwork arrives",
    run: () =>
      withReports("np-rotate", "nowplaying?long", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing", isPlaying);
        await artHits(key, true);
        const answers: Promise<Image | null>[] = [];
        for (let i = 0; i < ROTATIONS; i++) {
          await evaluate(key, `rotate(${i}); post("result", "true");`);
          const state = await reported(reports, `the artwork ${i} is reported`, (now) => !!now?.artwork?.endsWith(`/art-wait.png?r=${i}`));
          answers.push(downloaded(key, state!.artwork!).catch(() => null));
        }
        const images = await Promise.race([Promise.all(answers), pause(DOWNLOADS_SETTLE_MS).then(() => null)]);
        expectTrue(images !== null, `every download asked for answers within ${DOWNLOADS_SETTLE_MS} ms`);
        const hits = await artHits(key);
        console.info(`[ardia windows] self-check note: ${hits} artwork requests reached the server for ${ROTATIONS} rotations (the engine's downloads and Chromium's own, for the system media controls)`);
        expectPng(images![ROTATIONS - 1]!, "the newest artwork");
        expectEqual(images!.slice(0, -1).filter((image) => image?.uri).length, 0, "no earlier artwork arrives once it was replaced");
      }),
  },
  {
    name: "engine now playing: a route change to a frame declaring the same artwork still shows it",
    run: () =>
      withReports("np-route", "npframe?preload&slowart", FRAME_TITLE, async (key, reports, windowId) => {
        await playFrame(key, windowId);
        const state = await reported(reports, "the iframe's song is reported with its slow artwork", (now) => isPlaying(now) && !!now?.artwork?.endsWith("/art-slow.png"));
        const fetching = downloaded(key, state!.artwork!);
        await pause(200);
        const started = await evaluate(key, `mainSession(${JSON.stringify(state!.artwork)}).then((result) => post("result", JSON.stringify(result)));`, true);
        expectEqual(started, "played", "the page around the iframe plays its own song with the same artwork address, taking the route");
        await until("the route moves to the page around the iframe", SETTLE_MS, reports.latest, (now) => now?.title === "Main Song");
        expectPng(await fetching, "the artwork, still declared after the route moved");
      }),
  },
  {
    name: "engine now playing: a long artwork address is reported as a short token that downloads the image",
    run: () =>
      withReports("np-long-art", "nowplaying?longart", TITLE, async (key, reports) => {
        await startPlaying(key);
        const state = await reported(reports, "the page reports playing with its artwork", (now) => isPlaying(now) && !!now?.artwork);
        expectTrue(state!.artwork!.length <= LONGEST_REPORTED_ARTWORK, `the reported artwork is at most ${LONGEST_REPORTED_ARTWORK} characters, got ${state!.artwork!.length}`);
        expectPng(await downloaded(key, state!.artwork!), "the image the reported token downloads");
      }),
  },
  {
    name: "engine now playing: declared SVG artwork, from an address and from a data URL, arrives through the frame's own image downloader as a PNG within the size asked for",
    run: () =>
      withReports("np-svg-art", "nowplaying", TITLE, async (key, reports) => {
        await startPlaying(key);
        await reported(reports, "the page reports playing with its artwork", (now) => isPlaying(now) && !!now?.artwork);
        const declared = await evaluate(key, 'post("result", JSON.stringify(navigator.mediaSession.metadata.artwork.map((image) => image.src)));');
        const dataSvg = (Array.isArray(declared) ? (declared as string[]) : []).find((src) => src.startsWith(DATA_SVG_PREFIX));
        expectTrue(!!dataSvg, `the page declares a data: SVG artwork (${JSON.stringify(declared)})`);
        const shape = (image: Image | null) => (image?.uri ? { png: image.uri.startsWith("data:image/png;base64,"), width: image.width, height: image.height } : null);
        const fromAddress = shape(await downloaded(key, `${origin}/art.svg`));
        const fromData = shape(await downloaded(key, dataSvg!));
        console.info(`[ardia windows] self-check note: declared SVG artwork through the frame's image downloader: /art.svg ${JSON.stringify(fromAddress)}, data:image/svg+xml ${JSON.stringify(fromData)}`);
        for (const [what, image] of [["/art.svg", fromAddress], ["the data: SVG", fromData]] as const) {
          expectTrue(!!image && image.png && (image.width ?? 0) > 0 && (image.width ?? 0) <= 256 && (image.height ?? 0) > 0 && (image.height ?? 0) <= 256, `${what} arrives as a PNG within 256 px (${JSON.stringify(image)})`);
        }
      }),
  },
];

const publicPort = port ? testPort("publicPages") : null;
const httpsPort = port ? testPort("httpsPages") : null;

const addressSpaceChecks: Check[] = [
  {
    name: "engine now playing: a loopback artwork declared by a page Chromium treats as public is fetched only if the page itself may load it (local network access)",
    run: () =>
      withOtherOrigin("np-lna-art", `http://127.0.0.1:${publicPort}/nowplaying?lnaart=${port}`, async (key, reports, windowId) => {
        const space = await evaluate(key, 'post("result", JSON.stringify(window.isSecureContext));');
        const { own } = await refusedLikeTheFrame(key, reports, windowId, "/art-lna.png", `a loopback artwork from a public page (secure context ${JSON.stringify(space)})`);
        const rule = own === "pending" ? "held" : own === "error" ? "refused" : String(own);
        console.info(`[ardia windows] self-check note: on this runner, 157's local network rule for a public page's own loopback image: ${rule} (${JSON.stringify(own)})`);
      }),
  },
  {
    name: "engine now playing: an https page's http artwork is never fetched over http (mixed content)",
    run: () =>
      withOtherOrigin("np-mixed-art", `https://127.0.0.1:${httpsPort}/nowplaying?mixedart=${port}`, async (key, reports, windowId) => {
        const { own, fetched } = await refusedLikeTheFrame(key, reports, windowId, "/art-mixed.png", "an http artwork from an https page");
        expectEqual(fetched, 0, `the http artwork never reached the server over http (the page's own image: ${JSON.stringify(own)})`);
      }),
  },
];

export const checks: Check[] = port ? [...artworkChecks, ...(publicPort ? [addressSpaceChecks[0]!] : []), ...(httpsPort ? [addressSpaceChecks[1]!] : [])] : [];
