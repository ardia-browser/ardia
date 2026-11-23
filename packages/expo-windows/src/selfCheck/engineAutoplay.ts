import { hostCall, onEngineTopic } from "../engine/host";
import { mountPage } from "../engine/pages";
import { expectEqual, expectTrue, type Check } from "./check";
import { click, evaluate, firstWindow, LEFT, listed, pause, RIGHT, show, until } from "./engineSleep";
import { AUTOPLAY_SETTLES_MS, CTRL, DETACHED_MUTED_VIDEO, DETACHED_SOUND, LOAD_MS, NEXT_LINK, PER_PAGE_COUNT, PLAY_BUTTON, SETTLE_MS, blockEverywhere, blocked, blockedHeard, framed, held, loadedAt, origin, played, playing, port, refusedThenStill, restore, setAutoplay, setSite, stateOf, withMedia } from "./engineAutoplayKit";

const autoplayChecks: Check[] = [
  {
    name: "engine autoplay: a site set to Block gets no sound autoplay, and the held play is counted",
    run: async () => {
      try {
        await setAutoplay("block");
        const counted = blockedHeard("self-check-autoplay-sound", "a counted blocked play with sound");
        await withMedia("sound", "media?auto", "media page", async (key) => {
          const state = await until("the sound play is refused", SETTLE_MS, () => played(key), held);
          expectEqual(state.tries, ["NotAllowedError"], "play() with sound is refused as Chrome refuses a play nobody asked for");
          await counted;
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine autoplay: a site set to Block gets no muted autoplay either, and the held play is counted",
    run: async () => {
      try {
        await setAutoplay("block");
        const counted = blockedHeard("self-check-autoplay-muted", "a counted blocked muted play");
        await withMedia("muted", "media?auto-muted", "media page", async (key) => {
          await until("the muted autoplay is paused", SETTLE_MS, () => played(key), held);
          await counted;
          expectTrue(!playing(await played(key)), "the muted video stays paused");
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine autoplay: on a blocked site a click on the page's play button plays with sound",
    run: async () => {
      try {
        await setAutoplay("block");
        await withMedia("click", "media?auto-muted", "media page", async (key) => {
          await until("the muted autoplay is paused before the click", SETTLE_MS, () => played(key), held);
          await click(key, PLAY_BUTTON.x, PLAY_BUTTON.y);
          await evaluate(key, 'm.muted = false; post("result", "true");');
          const state = await until("the clicked play plays", SETTLE_MS, () => played(key), playing);
          expectEqual(state.tries?.at(-1), "played", "the click's play() resolves");
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine autoplay: a cross-site iframe on a blocked site gets no muted autoplay",
    run: async () => {
      try {
        await setAutoplay("block");
        const counted = blockedHeard("self-check-autoplay-frame", "a counted blocked play in the iframe");
        await withMedia("frame", "framed", "framed page", async (key) => {
          await until("the iframe reports its video", SETTLE_MS, () => framed(key), (state) => (state.tries?.length ?? 0) > 0);
          await until("the iframe's muted autoplay is paused", SETTLE_MS, () => framed(key), held);
          await counted;
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine autoplay: turning Block autoplay everywhere on pauses autoplay in an open tab without a reload",
    run: async () => {
      try {
        await withMedia("open", "media?auto-muted", "media page", async (key) => {
          await until("the muted autoplay plays while nothing blocks it", SETTLE_MS, () => played(key), playing);
          const counted = blockedHeard(key, "a counted pause in the open tab");
          expectEqual((await blockEverywhere(true)).everywhere, true, "the engine took Block autoplay everywhere");
          await until("the open tab's video is paused", SETTLE_MS, () => played(key), (state) => state.paused === true);
          await counted;
          expectEqual((await played(key)).tries, ["played"], "the page was not reloaded");
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine autoplay: with Block autoplay everywhere on, a site set to Allow still autoplays",
    run: async () => {
      try {
        expectEqual((await blockEverywhere(true)).everywhere, true, "the engine took Block autoplay everywhere");
        await setAutoplay("allow");
        await withMedia("allowed", "media?auto-muted", "media page", async (key) => {
          await until("the allowed site's muted autoplay plays", SETTLE_MS, () => played(key), playing);
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine autoplay: a muted video the page never inserted is refused on a blocked site",
    run: blocked(() => withMedia("detached", "media", "media page", (key) => refusedThenStill(key, DETACHED_MUTED_VIDEO, "a detached muted video"))),
  },
  {
    name: "engine autoplay: a detached Audio with sound is refused on a site whose Sound was allowed before blocking turned on",
    run: async () => {
      try {
        await setSite("sound", "allow");
        await withMedia("sound-allowed", "media", "media page", async (key) => {
          await setAutoplay("block");
          await pause(500);
          await refusedThenStill(key, DETACHED_SOUND, "a detached Audio with sound after the site's Sound allowance");
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine autoplay: a muted video in a closed shadow root is refused, by autoplay attribute and by play()",
    run: blocked(() =>
      withMedia("shadow", "media", "media page", async (key) => {
        const byPlay = await evaluate(
          key,
          `const root = document.body.appendChild(document.createElement("div")).attachShadow({ mode: "closed" }); window.shadowAttribute = root.appendChild(Object.assign(document.createElement("video"), { muted: true, autoplay: true, loop: true, src: "/tone.wav" })); const video = root.appendChild(Object.assign(document.createElement("video"), { muted: true, loop: true, src: "/tone.wav" })); window.shadowPlay = video; video.play().then(() => "played", (error) => error.name).then((result) => post("result", JSON.stringify(result)));`,
        );
        expectEqual(byPlay, "NotAllowedError", "play() on a muted video in a closed shadow root");
        await pause(AUTOPLAY_SETTLES_MS);
        expectEqual([(await stateOf(key, "window.shadowAttribute")).paused, (await stateOf(key, "window.shadowPlay")).paused], [true, true], "both shadow-root videos stay paused");
      }),
    ),
  },
  {
    name: "engine autoplay: a page that stops play events on window capture still gets no autoplay",
    run: blocked(() =>
      withMedia("stopped", "media", "media page", async (key) => {
        await evaluate(key, 'addEventListener("play", (event) => event.stopPropagation(), true); window.stopped = document.body.appendChild(Object.assign(document.createElement("video"), { muted: true, autoplay: true, loop: true, src: "/tone.wav" })); post("result", "true");');
        await refusedThenStill(key, DETACHED_MUTED_VIDEO, "a muted play() under the page's stopPropagation");
        await pause(AUTOPLAY_SETTLES_MS / 2);
        expectEqual((await stateOf(key, "window.stopped")).paused, true, "an autoplay attribute under the page's stopPropagation stays paused");
      }),
    ),
  },
  {
    name: "engine autoplay: an element named ardiaAutoplayGuard in the page changes nothing",
    run: blocked(() =>
      withMedia("clobber", "clobber", "clobber page", async (key) => {
        await pause(AUTOPLAY_SETTLES_MS);
        expectEqual((await stateOf(key, 'document.getElementById("m")')).paused, true, "the clobbering page's muted autoplay stays paused");
      }),
    ),
  },
  {
    name: "engine autoplay: after document.open() the page still gets no autoplay",
    run: blocked(() =>
      withMedia("reopen", "media", "media page", async (key) => {
        await evaluate(key, `document.open(); document.write("<title>reopened</title><video id=w src='/tone.wav' autoplay muted loop></video>"); document.close(); post("result", "true");`);
        await until("the reopened document shows", LOAD_MS, () => listed(key), (tab) => tab?.title === "reopened");
        await pause(AUTOPLAY_SETTLES_MS);
        expectEqual((await stateOf(key, 'document.getElementById("w")')).paused, true, "the rewritten document's muted autoplay stays paused");
        await refusedThenStill(key, DETACHED_MUTED_VIDEO, "a muted play() after document.open()");
      }),
    ),
  },
  {
    name: "engine autoplay: a click on page A does not let same-origin page B, reached by a link, play",
    run: blocked(() =>
      withMedia("next", "media", "media page", async (key) => {
        await click(key, NEXT_LINK.x, NEXT_LINK.y);
        await loadedAt(key, "/media?second", "media page");
        await refusedThenStill(key, DETACHED_SOUND, "page B's play with sound");
      }),
    ),
  },
  {
    name: "engine autoplay: a background tab opened by Ctrl+click on a same-site link does not play",
    run: blocked(async () => {
      const windowId = await firstWindow();
      const opener = "self-check-autoplay-ctrl";
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
        closeBackground = mountPage(background, { url: "", profile: "", adopt: offered[0], windowId }, () => {});
        await loadedAt(background, "/media?second", "media page");
        await show(background, windowId, RIGHT);
        await refusedThenStill(background, DETACHED_SOUND, "the background tab's play with sound");
      } finally {
        closeBackground?.();
        closeOpener();
      }
    }),
  },
  {
    name: "engine autoplay: Ardia's play toggle gives no user activation to a cross-site iframe",
    run: () =>
      withMedia("toggle", "framed?quiet", "framed page", async (key) => {
        await until("the iframe reports no activation yet", SETTLE_MS, () => framed(key), (state) => state.active === false);
        await hostCall("tab.call", { key, method: "mediaCommand", action: "toggle" });
        await pause(1000);
        expectEqual((await framed(key)).active, false, "navigator.userActivation.hasBeenActive in the cross-site iframe after Ardia's toggle");
      }),
  },
  {
    name: "engine autoplay: a page restored from the back/forward cache after its site was blocked gets no play, from pageshow or in its iframe",
    run: async () => {
      try {
        await withMedia("cached", "framed?quiet&showplay", "framed page", async (key) => {
          await until("the iframe reports", SETTLE_MS, () => framed(key), (state) => state.paused === true);
          await hostCall("tab.call", { key, method: "loadUrl", url: `${origin}/a` });
          await until("the next page loads", LOAD_MS, () => listed(key), (tab) => tab?.title === "loaded a");
          await setAutoplay("block");
          await hostCall("tab.call", { key, method: "goBack" });
          await until("the framed page is back", LOAD_MS, () => listed(key), (tab) => tab?.title === "framed page" && tab.loading === false);
          const shown = await until("the pageshow play answers", SETTLE_MS, async () => (await evaluate(key, 'post("result", JSON.stringify({ showPlay: window.showPlay, restored: window.restored }));')) as { showPlay?: unknown; restored?: unknown }, (now) => now.showPlay !== null && now.showPlay !== undefined);
          expectEqual(shown.showPlay, "NotAllowedError", `the play from pageshow once the framed page is back (restored from the cache: ${shown.restored})`);
          await until("the iframe reports again", SETTLE_MS, () => framed(key), (state) => state.paused === true);
          await evaluate(key, 'frameState = null; frames[0].postMessage("play-muted", "*"); post("result", "true");');
          const state = await until("the iframe answers the play", SETTLE_MS, () => framed(key), (now) => (now.tries?.length ?? 0) > 0);
          expectEqual(state.tries, ["NotAllowedError"], "the iframe's muted play once the framed page is back");
        });
      } finally {
        await restore();
      }
    },
  },
  {
    name: "engine autoplay: a top-level blob: page made by a blocked site gets no autoplay",
    run: blocked(() =>
      withMedia("blob", "media", "media page", async (key) => {
        await evaluate(key, `const url = URL.createObjectURL(new Blob(["<title>blob page</title><video id=b src='" + location.origin + "/tone.wav' autoplay muted loop></video>"], { type: "text/html" })); setTimeout(() => { location.href = url; }, 0); post("result", "true");`);
        await until("the blob: page shows", LOAD_MS, () => listed(key), (tab) => String(tab?.url).startsWith("blob:") && tab?.title === "blob page" && tab.loading === false);
        await pause(AUTOPLAY_SETTLES_MS);
        expectEqual((await stateOf(key, 'document.getElementById("b")')).paused, true, "the blob: page's muted autoplay stays paused");
      }),
    ),
  },
  {
    name: "engine autoplay: held plays are counted per page, at most 20 each, and a page change sends the last page's count on its own",
    run: blocked(async () => {
      const key = "self-check-autoplay-count";
      const counts: number[] = [];
      const watching = onEngineTopic("tab", (event: { key?: unknown; name?: unknown; data?: { count?: unknown } }) => {
        if (event.key === key && event.name === "autoplayBlocked") counts.push(Number(event.data?.count));
      });
      try {
        await withMedia("count", "media?burst", "media page", async () => {
          await hostCall("tab.call", { key, method: "loadUrl", url: `${origin}/media?burst-two` });
          await loadedAt(key, "/media?burst-two", "media page");
          await until("both pages' counts arrive", SETTLE_MS, async () => counts.reduce((sum, count) => sum + count, 0), (sum) => sum >= 2 * PER_PAGE_COUNT);
          await pause(1500);
        });
        expectTrue(counts.every((count) => count > 0 && count <= PER_PAGE_COUNT), `each count is one page's, at most ${PER_PAGE_COUNT}: ${JSON.stringify(counts)}`);
        expectEqual(counts.reduce((sum, count) => sum + count, 0), 2 * PER_PAGE_COUNT, `two pages of 25 held plays each: ${JSON.stringify(counts)}`);
      } finally {
        watching.remove();
      }
    }),
  },
];

export const checks: Check[] = port ? autoplayChecks : [];
