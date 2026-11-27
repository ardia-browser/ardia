import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { entryKind, popoverBoot, popoverChannel, POPOVER_MODULE, POPOVER_PROPS_EVENT, POPOVER_SELF_CLOSE, POPOVER_SELF_MESSAGE, POPOVER_SELF_PROPS } from "./popoverSurface.ts";
import { PopoverRoot, POPOVER_ROUTES } from "./PopoverRoot.tsx";

const bootstrap = (popover, extra = {}) => ({ bootstrap: { windowId: "w1", profileId: "", windowKind: "popover", surface: "popover", popover, ...extra } });

test("only a popover surface with a valid id and route boots the popover renderer", () => {
  assert.deepEqual(popoverBoot(bootstrap({ id: "popover-w1-ab-1", route: "list", props: { title: "Pick" } })), { id: "popover-w1-ab-1", route: "list", props: { title: "Pick" } });
  assert.deepEqual(popoverBoot(bootstrap({ id: "p1", route: "menus/list" })), { id: "p1", route: "menus/list", props: {} });
  for (const props of [[1], "x", 7, null, new Date(0), new Map()]) assert.equal(popoverBoot(bootstrap({ id: "p1", route: "list", props })), null, String(props));
  assert.deepEqual(popoverBoot(bootstrap({ id: "p1", route: "list", props: Object.assign(Object.create(null), { a: 1 }) }))?.props.a, 1);
  assert.equal(popoverBoot(undefined), null);
  assert.equal(popoverBoot({ bootstrap: { windowId: "w1", profileId: "", windowKind: "browser" } }), null);
  assert.equal(popoverBoot(bootstrap({ id: "p1", route: "list" }, { windowKind: "browser" })), null);
  for (const route of ["", "/list", "list/", "a/../b", "a//b", "a b", "x".repeat(129), 7]) assert.equal(popoverBoot(bootstrap({ id: "p1", route })), null, String(route));
  for (const id of ["", "a b", "a:b", "x".repeat(129), null]) assert.equal(popoverBoot(bootstrap({ id, route: "list" })), null, String(id));
  assert.equal(popoverBoot(bootstrap({ id: "p1", route: "list" }), "?popover=p1")?.id, "p1");
  assert.equal(popoverBoot(bootstrap({ id: "p1", route: "list" }), "?popover=p2"), null);
  assert.equal(popoverBoot(bootstrap({ id: "p1", route: "list" }), ""), null);
  assert.equal(popoverBoot(bootstrap({ id: "p1", route: "list" }), "?popover=p1&popover=p1"), null);
  assert.equal(popoverBoot(bootstrap({ id: "p1", route: "list" }), "?popover=p1&popover=p2"), null);
  assert.equal(entryKind(bootstrap({ id: "p1", route: "list" }), "?popover=p1&popover=p1").kind, "invalid");
  assert.equal(entryKind(bootstrap({ id: "p1", route: "list", props: [] }), "?popover=p1").kind, "invalid");
});

test("the channel closes, messages and reads its own props, and hears only its own props events", async () => {
  const calls = [];
  let listener = null;
  const host = {
    invoke: async (method, args) => {
      calls.push([method, args]);
      return method === POPOVER_SELF_PROPS ? { items: [] } : null;
    },
    onEvent: (next) => {
      listener = next;
      return () => void (listener = null);
    },
  };
  const channel = popoverChannel(host, { id: "p1", route: "list", props: {} });
  await channel.close();
  await channel.send({ type: "pick", id: "a" });
  assert.deepEqual(await channel.props(), { items: [] });
  assert.deepEqual(calls, [[POPOVER_SELF_CLOSE, {}], [POPOVER_SELF_MESSAGE, { message: { type: "pick", id: "a" } }], [POPOVER_SELF_PROPS, {}]]);
  const heard = [];
  const stop = channel.onProps((props) => heard.push(props));
  listener(POPOVER_MODULE, POPOVER_PROPS_EVENT, { id: "p1", props: { count: 1 } });
  listener(POPOVER_MODULE, POPOVER_PROPS_EVENT, { id: "p2", props: { count: 2 } });
  listener(POPOVER_MODULE, POPOVER_PROPS_EVENT, { id: "p1", props: [3] });
  listener("ArdiaShell", POPOVER_PROPS_EVENT, { id: "p1", props: { count: 4 } });
  listener(POPOVER_MODULE, POPOVER_PROPS_EVENT, null);
  assert.deepEqual(heard, [{ count: 1 }]);
  stop();
  assert.equal(listener, null);
});

const channel = { close: async () => {}, send: async () => {}, props: async () => null, onProps: () => () => {} };

test("the renderer draws only the requested popover's content, never the browser shell", () => {
  const html = renderToStaticMarkup(createElement(PopoverRoot, { boot: { id: "p1", route: "list", props: { title: "Open in", items: [{ id: "a", title: "Work", detail: "2 tabs" }, { id: "b", title: "Off", enabled: false }, { bad: true }] } }, channel }));
  assert.match(html, /ardia-popover-list/);
  assert.match(html, /Open in/);
  assert.match(html, /Work/);
  assert.match(html, /2 tabs/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /ardia-window|ardia-desktop/);
  assert.equal(renderToStaticMarkup(createElement(PopoverRoot, { boot: { id: "p1", route: "missing", props: {} }, channel })), "");
  assert.equal(renderToStaticMarkup(createElement(PopoverRoot, { boot: { id: "p1", route: "toString", props: {} }, channel })), "");
  assert.deepEqual(Object.keys(POPOVER_ROUTES), ["list", "downloads"]);
});

test("the downloads route draws its rows, actions and footer from props alone", () => {
  const rows = [
    { id: "run", title: "big.iso", status: "1 MB of 2 MB", warning: false, missing: false, progress: 0.5, paused: false, actions: ["pause", "cancel"] },
    { id: "done", title: "notes.pdf", status: "2 KB", warning: false, missing: false, progress: null, paused: false, actions: ["open", "reveal", "bogus"] },
    { id: "risky", title: "x.exe", status: "Blocked: not secure", warning: true, missing: false, progress: 7, paused: false, actions: ["keep", "discard"] },
    { title: "no id" },
  ];
  const html = renderToStaticMarkup(createElement(PopoverRoot, { boot: { id: "p1", route: "downloads", props: { rows, clearable: true, dark: true, revealTitle: "Show in Finder" } }, channel }));
  assert.match(html, /RECENT DOWNLOADS/);
  assert.match(html, /data-ardia-dark="true"/);
  assert.match(html, />Clear</);
  assert.match(html, /big\.iso/);
  assert.match(html, /width:50%/);
  assert.match(html, /width:100%/);
  assert.match(html, />Pause<.*>Cancel</);
  assert.match(html, /title="Show in Finder"/);
  assert.match(html, />Keep<.*>Discard</);
  assert.match(html, /data-warning="true"/);
  assert.doesNotMatch(html, /bogus|no id/);
  assert.match(html, /View all downloads/);
  const empty = renderToStaticMarkup(createElement(PopoverRoot, { boot: { id: "p1", route: "downloads", props: {} }, channel }));
  assert.match(empty, /No downloads yet/);
  assert.doesNotMatch(empty, />Clear</);
});

test("the entry boots a popover, the shell, or refuses a broken popover instead of loading the shell into a panel", () => {
  const good = bootstrap({ id: "p1", route: "list" });
  assert.equal(entryKind(good, "?popover=p1").kind, "popover");
  assert.deepEqual(entryKind({ bootstrap: { windowId: "w1", profileId: "", windowKind: "browser" } }, ""), { kind: "shell" });
  assert.deepEqual(entryKind(undefined, ""), { kind: "shell" });
  for (const [host, search] of [
    [good, "?popover=p2"],
    [good, ""],
    [bootstrap({ id: "p 1", route: "list" }), "?popover=p%201"],
    [bootstrap({ id: "p1", route: "../x" }), "?popover=p1"],
    [{ bootstrap: { windowId: "w1", profileId: "", windowKind: "browser" } }, "?popover=p1"],
    [bootstrap({ id: "p1", route: "list" }, { windowKind: "browser" }), "?popover=p1"],
    [undefined, "?popover=p1"],
  ]) assert.equal(entryKind(host, search).kind, "invalid", JSON.stringify([host?.bootstrap, search]));
});
