import { hostCall, leaveOffersFromUnheard } from "../engine/host";
import { mountPage } from "../engine/pages";
import { expectEqual, expectTrue, type Check } from "./check";
import { click, evaluate, firstWindow, LEFT, listed, pause, RIGHT, show, until } from "./engineSleep";
import { CTRL, DETACHED_MUTED_VIDEO, LOAD_MS, NEXT_LINK, PER_PAGE_COUNT, PLAY_BUTTON, SETTLE_MS, TOUCH_POINT, TRANSIENT_ACTIVATION_MS, blocked, countsOf, framed, held, loadedAt, mediaCommand, origin, played, playing, port, refusedThenStill, restore, setAutoplay, withMedia } from "./engineAutoplayKit";

const raced = (media: string) =>
  `Promise.race([${media}.play().then(() => "played", (error) => error.name), new Promise((resolve) => setTimeout(() => resolve("pending"), 1500))]).then((result) => post("result", JSON.stringify(result)));`;
const playsOn = (media: string) =>
  `Promise.race([${media}.play().then(() => new Promise((resolve) => { const start = ${media}.currentTime; setTimeout(() => resolve(!${media}.paused && !${media}.ended && ${media}.readyState >= 2 && ${media}.currentTime !== start ? "played" : "stalled at " + ${media}.currentTime), 800); }), (error) => error.name), new Promise((resolve) => setTimeout(() => resolve("pending"), 3000))]).then((result) => post("result", JSON.stringify(result)));`;
const POPUP_VIDEO = (popup: string) => `Object.assign(${popup}.document.createElement("video"), { muted: true, loop: true, src: location.origin + "/tone.wav" })`;
const CUT_POPUP_VIDEO = `const popup = window.open(""); window.cutPopup = popup; popup.opener = null; const video = ${POPUP_VIDEO("popup")}; ${playsOn("video")}`;
const WAITING_POPUP_VIDEO = `const video = ${POPUP_VIDEO("window.waitPopup")}; ${playsOn("video")}`;

const HAVE_CURRENT_DATA = 2;

async function advances(key: string, what: string) {
  const first = await played(key);
  await pause(800);
  const later = await played(key);
  const going = (state: typeof first) => state.paused === false && state.ended === false && (state.ready ?? 0) >= HAVE_CURRENT_DATA;
  expectEqual({ playing: going(first) && going(later), moved: later.time !== first.time }, { playing: true, moved: true }, `${what} (currentTime ${first.time} then ${later.time}, readyState ${later.ready})`);
}

async function waitingPopupPlays(key: string, meanwhile: () => Promise<void>) {
  leaveOffersFromUnheard(key);
  try {
    expectEqual(await evaluate(key, 'window.waitPopup = window.open(""); post("result", JSON.stringify(!!window.waitPopup));', true), true, "the page opens a blank pop-up");
    await meanwhile();
    await pause(300);
    return await evaluate(key, WAITING_POPUP_VIDEO);
  } finally {
    leaveOffersFromUnheard(null);
    await evaluate(key, 'if (window.waitPopup) window.waitPopup.close(); post("result", "true");').catch(() => null);
  }
}
const NESTED_BLANK_VIDEO = `let doc = document; for (let i = 0; i < 64; i++) { const frame = doc.createElement("iframe"); (doc.body || doc.documentElement).append(frame); doc = frame.contentDocument; } const video = Object.assign(doc.createElement("video"), { muted: true, loop: true, src: location.origin + "/tone.wav" }); ${raced("video")}`;
const SCROLLER = 'window.downs = 0; addEventListener("pointerdown", () => { downs++; }, true); const scroller = document.body.appendChild(document.createElement("div")); scroller.style.cssText = "position:fixed;left:0;top:0;width:200px;height:150px;overflow-y:scroll;z-index:9;background:#eee"; scroller.appendChild(document.createElement("div")).style.height = "2000px"; post("result", "true");';
const SCROLLBAR_POINT = { x: 196, y: 60 };

async function cutPopupPlays(key: string) {
  leaveOffersFromUnheard(key);
  try {
    return await evaluate(key, CUT_POPUP_VIDEO, true);
  } finally {
    leaveOffersFromUnheard(null);
    await evaluate(key, 'if (window.cutPopup) window.cutPopup.close(); post("result", "true");').catch(() => null);
  }
}

const askChecks: Check[] = [
  {
    name: "engine autoplay: on a site that blocks nothing, a muted video Ardia's play control started keeps playing when the page unmutes it",
    run: () =>
      withMedia("control-unmute", "media?muted", "media page", async (key) => {
        await mediaCommand(key, "play");
        await until("Ardia's play control plays the muted video", SETTLE_MS, () => played(key), playing);
        await evaluate(key, 'm.muted = false; post("result", "true");');
        await pause(1000);
        await advances(key, "the video keeps playing once the page unmutes it");
      }),
  },
  {
    name: "engine autoplay: Ardia's play toggle that pauses gives the page no user activation",
    run: () =>
      withMedia("toggle-pause", "media?auto-muted", "media page", async (key) => {
        await until("the muted autoplay plays", SETTLE_MS, () => played(key), playing);
        await mediaCommand(key, "toggle");
        await until("the toggle pauses it", SETTLE_MS, () => played(key), (state) => state.paused === true);
        expectEqual(await evaluate(key, 'post("result", JSON.stringify(navigator.userActivation.hasBeenActive));'), false, "the page's navigator.userActivation.hasBeenActive after a pausing toggle");
      }),
  },
  {
    name: "engine autoplay: media Ardia's play control started before blocking turned on keeps playing",
    run: async () => {
      try {
        await withMedia("control-then-block", "media?muted", "media page", async (key) => {
          await mediaCommand(key, "play");
          await until("Ardia's play control plays the muted video", SETTLE_MS, () => played(key), playing);
          await setAutoplay("block");
          await pause(1000);
          await advances(key, "the video the user asked for through Ardia keeps playing after blocking turns on");
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine autoplay: media a click started before blocking turned on keeps playing",
    run: async () => {
      try {
        await withMedia("click-then-block", "media?muted", "media page", async (key) => {
          await click(key, PLAY_BUTTON.x, PLAY_BUTTON.y);
          await until("the click plays the muted video", SETTLE_MS, () => played(key), playing);
          await setAutoplay("block");
          await pause(1000);
          await advances(key, "the video the user clicked keeps playing after blocking turns on");
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine autoplay: a Media Session play from the user lets the page's play handler play on a blocked site",
    run: async () => {
      try {
        await withMedia("session", "media?session", "media page", async (key) => {
          const started = await evaluate(key, 'm.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));', true);
          expectEqual(started, "played", "the page plays with sound under a script gesture, so its media session has a player");
          await until("it plays", SETTLE_MS, () => played(key), playing);
          await evaluate(key, 'm.pause(); post("result", "true");');
          await setAutoplay("block");
          await pause(500);
          await hostCall("tab.call", { key, method: "mediaSessionActionForTest", action: "play" });
          const state = await until("the page's play handler answers", SETTLE_MS, () => played(key), (now) => (now.tries?.length ?? 0) > 0);
          expectEqual(state.tries, ["played"], "the play handler's play() after the user's Media Session play");
          await advances(key, "the handler's video plays");
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine autoplay: a play() in a touch pointerdown handler plays on a blocked site",
    run: blocked(() =>
      withMedia("touch", "media?touchplay-muted", "media page", async (key) => {
        await hostCall("tab.call", { key, method: "touchForTest", x: TOUCH_POINT.x, y: TOUCH_POINT.y });
        const state = await until("the touch's play answers", SETTLE_MS, () => played(key), (now) => (now.tries?.length ?? 0) > 0);
        expectEqual(state.tries, ["played"], "play() inside the page's touch pointerdown handler");
        await advances(key, "the touched video plays");
      }),
    ),
  },
  {
    name: "engine autoplay: a play() on an iframe's video that is already playing is not counted as refused once the iframe's activation has expired",
    run: blocked(async () => {
      const count = countsOf("self-check-autoplay-again");
      try {
        await withMedia("again", "framed?quiet-same", "framed page", async (key) => {
          await until("the iframe reports", SETTLE_MS, () => framed(key), (state) => state.paused === true);
          const first = await evaluate(key, 'const media = document.querySelector("iframe").contentWindow.m; media.muted = true; media.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));', true);
          expectEqual(first, "played", "the same-origin iframe plays under the top page's script gesture (transient activation)");
          await pause(TRANSIENT_ACTIVATION_MS);
          const before = count.total();
          const again = await evaluate(key, 'document.querySelector("iframe").contentWindow.m.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));');
          await pause(1500);
          expectEqual({ again, counted: count.total() - before }, { again: "played", counted: 0 }, "play() again on the playing iframe video after the activation expired");
        });
      } finally {
        count.stop();
      }
    }),
  },
  {
    name: "engine autoplay: a page restored from the back/forward cache counts no more than 20 held plays in all",
    run: blocked(async () => {
      const count = countsOf("self-check-autoplay-page-count");
      try {
        await withMedia("page-count", "framed?same&burst", "framed page", async (key) => {
          await until("the first visit's count arrives", SETTLE_MS, async () => count.total(), (total) => total >= PER_PAGE_COUNT);
          await hostCall("tab.call", { key, method: "loadUrl", url: `${origin}/a` });
          await until("the next page loads", LOAD_MS, () => listed(key), (tab) => tab?.title === "loaded a");
          await hostCall("tab.call", { key, method: "goBack" });
          await until("the framed page is back", LOAD_MS, () => listed(key), (tab) => tab?.title === "framed page" && tab.loading === false);
          expectEqual(await evaluate(key, 'post("result", JSON.stringify(window.restored));'), true, "the framed page came back from the back/forward cache");
          await pause(2500);
          expectTrue(count.total() <= PER_PAGE_COUNT, `held plays counted for the page across its restore, at most ${PER_PAGE_COUNT}: ${JSON.stringify(count.counts)}`);
        });
      } finally {
        count.stop();
      }
    }),
  },
  {
    name: "engine autoplay: a background tab opened before its site was blocked follows the block once the app adopts it",
    run: async () => {
      const windowId = await firstWindow();
      const opener = "self-check-autoplay-late";
      const background = `${opener}-background`;
      const offered: string[] = [];
      const closeOpener = mountPage(opener, { url: `${origin}/media`, profile: "", windowId }, (name, data) => {
        const adopt = (data as { adoptId?: unknown } | null)?.adoptId;
        if (name === "openWindow" && typeof adopt === "string") offered.push(adopt);
      });
      let closeBackground: (() => void) | null = null;
      try {
        await loadedAt(opener, "/media", "media page");
        await show(opener, windowId, LEFT);
        await click(opener, NEXT_LINK.x, NEXT_LINK.y, CTRL);
        await until("the Ctrl+click's tab is offered to the page", SETTLE_MS, async () => offered.length, (count) => count > 0);
        await pause(1000);
        await setAutoplay("block");
        closeBackground = mountPage(background, { url: "", profile: "", adopt: offered[0], windowId }, () => {});
        await loadedAt(background, "/media?second", "media page");
        await show(background, windowId, RIGHT);
        await refusedThenStill(background, DETACHED_MUTED_VIDEO, "the adopted tab's muted play");
      } finally {
        closeBackground?.();
        closeOpener();
        await restore();
      }
    },
  },
  {
    name: "engine autoplay: on a site that blocks nothing, a pop-up whose opener link the page cut plays muted media",
    run: () =>
      withMedia("cut-popup", "media", "media page", async (key) => {
        const result = await cutPopupPlays(key);
        expectEqual(result, "played", "the cut pop-up's muted video plays and its currentTime advances");
      }),
  },
  {
    name: "engine autoplay: a blocked site's pop-up whose opener link the page cut refuses muted media",
    run: blocked(() =>
      withMedia("cut-popup-blocked", "media", "media page", async (key) => {
        expectEqual(await cutPopupPlays(key), "NotAllowedError", "the cut pop-up's muted play() on a blocked site");
      }),
    ),
  },
  {
    name: "engine autoplay: a video in the innermost of 64 nested blank iframes on a blocked site is refused",
    run: blocked(() =>
      withMedia("nested", "media", "media page", async (key) => {
        expectEqual(await evaluate(key, NESTED_BLANK_VIDEO), "NotAllowedError", "the innermost blank iframe's muted play()");
      }),
    ),
  },
  {
    name: "engine autoplay: a touch an element's scrollbar takes does not count as the user asking",
    run: blocked(() =>
      withMedia("scrollbar-touch", "media", "media page", async (key) => {
        await evaluate(key, SCROLLER);
        await hostCall("tab.call", { key, method: "touchForTest", x: SCROLLBAR_POINT.x, y: SCROLLBAR_POINT.y });
        await pause(300);
        const downs = await evaluate(key, 'post("result", JSON.stringify(window.downs));');
        expectEqual(downs, 0, "the touch on the scrollbar reached the page as no pointerdown (the case under test)");
        expectEqual(await evaluate(key, raced(DETACHED_MUTED_VIDEO)), "NotAllowedError", "a muted play() after the scrollbar touch");
      }),
    ),
  },
  {
    name: "engine autoplay: a blank pop-up waiting for the app refuses muted media once its site is blocked",
    run: async () => {
      try {
        await withMedia("waiting-on", "media", "media page", async (key) => {
          expectEqual(await waitingPopupPlays(key, () => setAutoplay("block")), "NotAllowedError", "the waiting pop-up's muted play() after the site was blocked");
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine autoplay: a blank pop-up waiting for the app plays muted media once its site is unblocked",
    run: blocked(() =>
      withMedia("waiting-off", "media", "media page", async (key) => {
        expectEqual(await waitingPopupPlays(key, () => setAutoplay("default")), "played", "the waiting pop-up's muted video plays after the site was unblocked, and its currentTime advances");
      }),
    ),
  },
];export const checks: Check[] = port ? askChecks : [];
