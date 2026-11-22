import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Action,
  ActionPanel,
  Box,
  Button,
  List,
  PluginError,
  SidebarView,
  Text,
  createContext,
  createElement,
  createHostRuntime,
  isHandlerRef,
  jsx,
  jsxs,
  mountSurface,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSurface,
} from "./index.ts";

const settle = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

function mount(Component, props = {}) {
  const commits = [];
  const errors = [];
  const handle = mountSurface(Component, props, (tree) => commits.push(tree), { onError: (e) => errors.push(e) });
  return { handle, commits, errors, last: () => commits.at(-1) };
}

function findNode(tree, predicate) {
  if (!tree || typeof tree !== "object") return null;
  if (predicate(tree)) return tree;
  for (const child of tree.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  for (const value of Object.values(tree.props ?? {})) {
    if (value && typeof value === "object" && "type" in value) {
      const found = findNode(value, predicate);
      if (found) return found;
    }
  }
  return null;
}

const byType = (type, title) => (node) => node.type === type && (title === undefined || node.props.title === title);

describe("JSX runtime", () => {
  test("elements carry keys out of props and createElement gathers children", () => {
    const element = jsx(Text, { key: "a", children: "hi" });
    assert.equal(element.key, "a");
    assert.equal("key" in element.props, false);
    const built = createElement(Box, { gap: "s" }, "one", "two");
    assert.deepEqual(built.props.children, ["one", "two"]);
  });

  test("host components serialize to plugin nodes with text children", () => {
    const { last } = mount(() => jsxs(Box, { direction: "row", children: [jsx(Text, { tone: "accent", children: ["Count ", 3] }), null, false] }));
    assert.deepEqual(last(), {
      type: "Box",
      props: { direction: "row" },
      children: [{ type: "Text", props: { tone: "accent" }, children: ["Count ", "3"] }],
    });
  });

  test("useState batches several updates from one event into one commit", async () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return jsx(Button, {
        title: `Count ${count}`,
        onPress: () => {
          setCount((n) => n + 1);
          setCount((n) => n + 1);
        },
      });
    }
    const { handle, commits, last } = mount(Counter);
    assert.equal(commits.length, 1);
    handle.dispatch(last().props.onPress.__handler);
    await settle();
    assert.equal(commits.length, 2);
    assert.equal(last().props.title, "Count 2");
  });

  test("useEffect runs after commit, cleans up on deps change and on unmount", async () => {
    const log = [];
    let bump;
    function Watcher() {
      const [n, setN] = useState(0);
      bump = () => setN((v) => v + 1);
      useEffect(() => {
        log.push(`run ${n}`);
        return () => log.push(`cleanup ${n}`);
      }, [n]);
      useEffect(() => {
        log.push("once");
      }, []);
      return jsx(Text, { children: String(n) });
    }
    const { handle } = mount(Watcher);
    assert.deepEqual(log, ["run 0", "once"]);
    bump();
    await settle();
    assert.deepEqual(log, ["run 0", "once", "cleanup 0", "run 1"]);
    handle.unmount();
    assert.deepEqual(log.at(-1), "cleanup 1");
  });

  test("useMemo, useCallback and useRef keep values between renders", async () => {
    let computed = 0;
    let rerender;
    const callbacks = [];
    function Memo() {
      const [tick, setTick] = useState(0);
      const [dep, setDep] = useState("a");
      rerender = { tick: () => setTick((t) => t + 1), dep: () => setDep("b") };
      const value = useMemo(() => {
        computed++;
        return dep.toUpperCase();
      }, [dep]);
      const ref = useRef(0);
      ref.current++;
      const onPress = useCallback(() => value, [value]);
      callbacks.push(onPress);
      return jsx(Button, { title: `${value} ${ref.current} ${tick}`, onPress });
    }
    const { last } = mount(Memo);
    const firstId = last().props.onPress.__handler;
    rerender.tick();
    await settle();
    assert.equal(computed, 1);
    assert.equal(last().props.title, "A 2 1");
    assert.equal(callbacks[0], callbacks[1]);
    assert.equal(last().props.onPress.__handler, firstId);
    rerender.dep();
    await settle();
    assert.equal(computed, 2);
    assert.equal(last().props.title, "B 3 1");
    assert.notEqual(callbacks[1], callbacks[2]);
  });

  test("useReducer dispatches through the latest reducer", async () => {
    let send;
    function Tally({ step }) {
      const [state, dispatch] = useReducer((s, a) => (a === "add" ? s + step : s - step), 10);
      send ??= dispatch;
      return jsx(Text, { children: String(state) });
    }
    const { handle, last } = mount(Tally, { step: 1 });
    send("add");
    send("add");
    send("sub");
    await settle();
    assert.deepEqual(last().children, ["11"]);
    handle.update({ step: 100 });
    await settle();
    send("add");
    await settle();
    assert.deepEqual(last().children, ["111"]);
  });

  test("useContext reads the nearest provider and falls back to the default", () => {
    const Theme = createContext("plain");
    const Label = () => jsx(Text, { children: useContext(Theme) });
    const { last } = mount(() =>
      jsxs(Box, {
        children: [
          jsx(Label, {}),
          jsx(Theme.Provider, { value: "outer", children: jsxs(Box, { children: [jsx(Label, {}), jsx(Theme.Provider, { value: "inner", children: jsx(Label, {}) })] }) }),
          jsx(Theme.Consumer, { children: (v) => jsx(Text, { children: `consumer ${v}` }) }),
        ],
      }),
    );
    const texts = [];
    const walk = (n) => (typeof n === "string" ? texts.push(n) : n.children.forEach(walk));
    walk(last());
    assert.deepEqual(texts, ["plain", "outer", "inner", "consumer plain"]);
  });

  test("keyed lists keep each item's state when reordered and clean up removed items", async () => {
    const cleaned = [];
    function Row({ id }) {
      const [clicks, setClicks] = useState(0);
      useEffect(() => () => cleaned.push(id), []);
      return jsx(List.Item, { id, title: `${id}:${clicks}`, onSelect: () => setClicks((c) => c + 1) });
    }
    let setOrder;
    function Rows() {
      const [order, set] = useState(["a", "b", "c"]);
      setOrder = set;
      return jsx(List, { children: jsx(List.Section, { title: "Rows", children: order.map((id) => jsx(Row, { id }, id)) }) });
    }
    const { handle, last } = mount(Rows);
    const items = () => last().children[0].children;
    assert.deepEqual(items().map((n) => n.key), ["a", "b", "c"]);
    handle.dispatch(items()[1].props.onSelect.__handler);
    await settle();
    assert.equal(items()[1].props.title, "b:1");
    setOrder(["c", "b"]);
    await settle();
    assert.deepEqual(items().map((n) => n.props.title), ["c:0", "b:1"]);
    assert.deepEqual(cleaned, ["a"]);
  });

  test("changing a single child's key remounts it with fresh state and cleans up the old one", async () => {
    const log = [];
    const setters = {};
    function Editor({ id }) {
      const [draft, setDraft] = useState(`draft ${id}`);
      setters.draft = setDraft;
      useEffect(() => {
        log.push(`mount ${id}`);
        return () => log.push(`cleanup ${id}`);
      }, []);
      return jsx(Text, { children: draft });
    }
    function Host() {
      const [record, setRecord] = useState({ key: undefined, id: "none" });
      setters.record = setRecord;
      return jsx(Box, { children: jsx(Editor, { id: record.id }, record.key) });
    }
    const { last } = mount(Host);
    const text = () => last().children[0].children[0];
    assert.equal(text(), "draft none");
    setters.draft("edited none");
    await settle();
    assert.equal(text(), "edited none");
    setters.record({ key: "a", id: "a" });
    await settle();
    assert.equal(text(), "draft a");
    assert.deepEqual(log, ["mount none", "cleanup none", "mount a"]);
    setters.draft("edited a");
    await settle();
    setters.record({ key: "a", id: "a" });
    await settle();
    assert.equal(text(), "edited a");
    setters.record({ key: "b", id: "b" });
    await settle();
    assert.equal(text(), "draft b");
    setters.record({ key: undefined, id: "plain" });
    await settle();
    assert.equal(text(), "draft plain");
    assert.deepEqual(log, ["mount none", "cleanup none", "mount a", "cleanup a", "mount b", "cleanup b", "mount plain"]);
  });

  test("callbacks nested in ActionPanel props, arrays and plain objects dispatch", async () => {
    const seen = [];
    function Item() {
      const [done, setDone] = useState(false);
      return jsx(List.Item, {
        title: done ? "Done" : "Todo",
        accessories: [{ text: "tag", onPress: () => seen.push("accessory") }],
        meta: { nested: { run: (x) => seen.push(`meta ${x}`) } },
        actions: jsxs(ActionPanel, {
          title: "Actions",
          children: [
            jsx(Action, { title: "Finish", onAction: () => setDone(true) }),
            jsx(Action.OpenInBrowser, { url: "https://example.com" }),
            jsx(Action.CopyToClipboard, { content: "copied", onCopy: () => seen.push("copy") }),
          ],
        }),
      });
    }
    const { handle, last } = mount(Item);
    const tree = last();
    assert.equal(tree.props.actions.type, "ActionPanel");
    const [finish, open, copy] = tree.props.actions.children;
    assert.ok(isHandlerRef(finish.props.onAction));
    assert.deepEqual(open.props, { title: "Open in Browser", icon: "safari", url: "https://example.com" });
    assert.equal(copy.props.copy, "copied");
    handle.dispatch(copy.props.onAction.__handler);
    handle.dispatch(tree.props.accessories[0].onPress.__handler);
    handle.dispatch(tree.props.meta.nested.run.__handler, ["x"]);
    handle.dispatch(finish.props.onAction.__handler);
    await settle();
    assert.deepEqual(seen, ["copy", "accessory", "meta x"]);
    assert.equal(last().props.title, "Done");
    assert.throws(() => handle.dispatch("h999"), /no handler h999/);
  });

  test("a render error becomes an error view and a looping update is stopped", async () => {
    const { last, errors } = mount(() => {
      throw new Error("boom");
    });
    assert.equal(last().type, "EmptyState");
    assert.equal(last().props.description, "boom");
    assert.equal(errors.length, 1);
    function Loop() {
      const [n, setN] = useState(0);
      useEffect(() => setN(n + 1));
      return jsx(Text, { children: String(n) });
    }
    const looped = mount(Loop);
    await settle(80);
    assert.equal(looped.last().type, "EmptyState");
    assert.match(looped.last().props.description, /looping/);
  });

  test("an onCommit that updates and flushes on every commit never re-enters a render and stops at the limit", async () => {
    const commits = [];
    let depth = 0;
    let deepest = 0;
    let handle = null;
    handle = mountSurface(
      () => jsx(Text, { children: "x" }),
      {},
      (tree) => {
        depth++;
        deepest = Math.max(deepest, depth);
        commits.push(tree);
        if (handle) {
          handle.update({});
          handle.flush();
        }
        depth--;
      },
      { onError: () => {}, maxRenders: 5 },
    );
    handle.update({});
    handle.flush();
    await settle(40);
    assert.equal(deepest, 1);
    assert.ok(commits.length <= 8, `committed ${commits.length} times`);
    assert.equal(commits.at(-1).type, "EmptyState");
    assert.match(commits.at(-1).props.description, /looping/);
  });

  test("numeric and string keys that print the same stay separate rows and keep their state when swapped", async () => {
    function Row({ label }) {
      const [n, setN] = useState(0);
      return jsx(Button, { title: `${label} ${n}`, onPress: () => setN((v) => v + 1) });
    }
    function Rows({ order }) {
      return jsx(Box, { children: order.map((key) => jsx(Row, { key, label: typeof key })) });
    }
    const { handle, last } = mount(Rows, { order: [1, "1"] });
    handle.dispatch(findNode(last(), byType("Button", "number 0")).props.onPress.__handler);
    await settle();
    assert.deepEqual(last().children.map((row) => row.props.title), ["number 1", "string 0"]);
    handle.update({ order: ["1", 1] });
    await settle();
    assert.deepEqual(last().children.map((row) => row.props.title), ["string 0", "number 1"]);
  });

  test("a button replaced by a new key gets a new handler id, so a late event for the old one can't reach it", async () => {
    const pressed = [];
    function One({ id }) {
      return jsx(Box, { children: jsx(Button, { key: id, title: id, onPress: () => pressed.push(id) }) });
    }
    const { handle, last } = mount(One, { id: "a" });
    const first = last().children[0].props.onPress.__handler;
    handle.update({ id: "a" });
    await settle();
    assert.equal(last().children[0].props.onPress.__handler, first);
    handle.update({ id: "b" });
    await settle();
    const second = last().children[0].props.onPress.__handler;
    assert.notEqual(second, first);
    assert.throws(() => handle.dispatch(first), /no handler/);
    handle.dispatch(second);
    assert.deepEqual(pressed, ["b"]);
  });

  test("an onError that updates on every error can't push renders past the limit", async () => {
    const errors = [];
    let handle = null;
    function Loop() {
      const [n, setN] = useState(0);
      useEffect(() => setN(n + 1));
      return jsx(Text, { children: String(n) });
    }
    handle = mountSurface(Loop, {}, () => {}, {
      maxRenders: 5,
      onError: (error) => {
        errors.push(error);
        if (errors.length < 200) handle?.update({});
      },
    });
    await settle(40);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /looping/);
  });

  test("a cleanup that closes the surface during a render stops that render from committing", async () => {
    const commits = [];
    let handle = null;
    function Child() {
      useEffect(() => () => handle.unmount(), []);
      return jsx(Text, { children: "child" });
    }
    function Parent({ show }) {
      return jsx(Box, { children: show ? jsx(Child, {}) : jsx(Text, { children: "gone" }) });
    }
    handle = mountSurface(Parent, { show: true }, (tree) => commits.push(tree), { onError: () => {} });
    handle.update({ show: false });
    await settle();
    assert.equal(commits.length, 1);
    assert.equal(handle.tree, commits[0]);
  });

  test("a render that closes its surface and then throws still cleans up the rows it dropped", async () => {
    let cleanups = 0;
    let handle = null;
    function Row() {
      useEffect(() => () => cleanups++, []);
      return jsx(Text, { children: "row" });
    }
    function Closer({ close }) {
      if (close) {
        handle.unmount();
        throw new Error("closed mid-render");
      }
      return null;
    }
    function Page({ close }) {
      return jsx(Box, { children: [jsx(Box, { key: "left", children: close ? null : jsx(Row, {}) }), jsx(Closer, { key: "closer", close })] });
    }
    handle = mountSurface(Page, { close: false }, () => {}, { onError: () => {} });
    handle.update({ close: true });
    await settle();
    assert.equal(cleanups, 1);
  });

  test("an onError that throws still leaves the surface able to render", () => {
    const commits = [];
    let broken = true;
    function Flaky({ bad }) {
      if (bad) throw new Error("bad");
      return jsx(Text, { children: "fine" });
    }
    const handle = mountSurface(Flaky, { bad: false }, (tree) => commits.push(tree), {
      onError: () => {
        if (!broken) return;
        broken = false;
        throw new Error("reporter broke");
      },
    });
    handle.update({ bad: true });
    assert.throws(() => handle.flush(), /reporter broke/);
    handle.update({ bad: false });
    handle.flush();
    assert.deepEqual(commits.at(-1), { type: "Text", props: {}, children: ["fine"] });
  });

  test("a row dropped by a render that later throws keeps its state and isn't cleaned up", async () => {
    let cleanups = 0;
    function Row({ id }) {
      const [n, setN] = useState(0);
      useEffect(() => () => cleanups++, []);
      return jsx(Button, { title: `${id} ${n}`, onPress: () => setN((v) => v + 1) });
    }
    function Boom({ explode }) {
      if (explode) throw new Error("boom");
      return null;
    }
    function Page({ showA, explode }) {
      return jsx(Box, {
        children: [jsx(Box, { key: "left", children: showA ? jsx(Row, { id: "a" }) : null }), jsx(Boom, { key: "boom", explode })],
      });
    }
    const { handle, last } = mount(Page, { showA: true, explode: false });
    handle.dispatch(findNode(last(), byType("Button", "a 0")).props.onPress.__handler);
    await settle();
    handle.update({ showA: false, explode: true });
    await settle();
    assert.equal(last().type, "EmptyState");
    assert.equal(cleanups, 0);
    handle.update({ showA: true, explode: false });
    await settle();
    assert.ok(findNode(last(), byType("Button", "a 1")));
    handle.update({ showA: false, explode: false });
    await settle();
    assert.equal(cleanups, 1);
  });

  test("an effect that unmounts its own surface still has the cleanup it returns run", async () => {
    let cleaned = 0;
    let handle = null;
    function Closer() {
      useEffect(() => {
        handle?.unmount();
        return () => cleaned++;
      });
      return jsx(Text, { children: "x" });
    }
    handle = mountSurface(Closer, {}, () => {}, { onError: () => {} });
    handle.update({});
    await settle();
    assert.equal(cleaned, 2);
  });

  test("a render that throws after useEffect leaves no effect bookkeeping, so the next good render runs it", async () => {
    let failing = true;
    let mounted = 0;
    const seenDeps = [];
    function Flaky({ dep }) {
      useEffect(() => {
        mounted++;
      }, []);
      useEffect(() => {
        seenDeps.push(dep);
      }, [dep]);
      if (failing) throw new Error("not yet");
      return jsx(Text, { children: `ok ${dep}` });
    }
    const { handle, last, errors } = mount(Flaky, { dep: 1 });
    assert.equal(last().type, "EmptyState");
    assert.equal(errors.length, 1);
    assert.equal(mounted, 0);
    failing = false;
    handle.update({ dep: 1 });
    handle.flush();
    assert.deepEqual(last(), { type: "Text", props: {}, children: ["ok 1"] });
    assert.equal(mounted, 1);
    assert.deepEqual(seenDeps, [1]);
    failing = true;
    handle.update({ dep: 2 });
    handle.flush();
    assert.equal(last().type, "EmptyState");
    assert.deepEqual(seenDeps, [1]);
    failing = false;
    handle.update({ dep: 2 });
    handle.flush();
    assert.deepEqual(last(), { type: "Text", props: {}, children: ["ok 2"] });
    assert.equal(mounted, 1);
    assert.deepEqual(seenDeps, [1, 2]);
    await settle();
    assert.equal(mounted, 1);
    assert.equal(errors.length, 2);
  });

  test("each useId call in a component gets its own id that stays put across renders", async () => {
    let bump;
    const seen = [];
    function Labelled() {
      const first = useId();
      const [count, setCount] = useState(0);
      const second = useId();
      bump = () => setCount((n) => n + 1);
      seen.push([first, second]);
      return jsx(Text, { children: `${first} ${second} ${count}` });
    }
    const { commits } = mount(Labelled);
    bump();
    await settle();
    assert.equal(commits.length, 2);
    assert.equal(seen.length, 2);
    const [[first, second], [firstAgain, secondAgain]] = seen;
    assert.notEqual(first, second);
    assert.equal(firstAgain, first);
    assert.equal(secondAgain, second);
  });

  test("hooks in a changed order fail loudly", async () => {
    let flip;
    function Bad() {
      const [on, setOn] = useState(false);
      flip = () => setOn(true);
      if (on) useRef(0);
      else useMemo(() => 1, []);
      return null;
    }
    const { last } = mount(Bad);
    flip();
    await settle();
    assert.match(last().props.description, /changed from memo to ref/);
  });
});

const SILENT = Symbol("silent");

const outcome = (promise, ms = 50) =>
  Promise.race([promise.then(() => "resolved", (error) => error), new Promise((resolve) => setTimeout(() => resolve("pending"), ms))]);

function fakeHost(replies = {}) {
  const sent = [];
  let listener = null;
  const transport = {
    send(line) {
      const message = JSON.parse(line);
      sent.push(message);
      if (typeof message.method !== "string") return;
      setImmediate(async () => {
        const reply = replies[message.method];
        if (reply === SILENT) return;
        try {
          const result = typeof reply === "function" ? await reply(message.params) : reply === undefined ? { ok: true } : reply;
          listener(JSON.stringify({ id: message.id, result }));
        } catch (error) {
          listener(JSON.stringify({ id: message.id, error: { code: error.code ?? "failed", message: error.message } }));
        }
      });
    },
    onLine(fn) {
      listener = fn;
    },
  };
  return {
    transport,
    sent,
    push: (message) => listener(JSON.stringify(message)),
    calls: (method) => sent.filter((m) => m.method === method),
    resultFor: (call) => sent.find((m) => m.method === "result" && m.params.call === call)?.params,
    renders: (surfaceId) => sent.filter((m) => m.method === "surface.render" && m.params.surfaceId === surfaceId).map((m) => m.params.tree),
  };
}

const hello = { app: "Ardia", version: "0.2.47", protocol: 2, plugin: "v2-test", values: { greeting: "Hi", loud: false } };

async function started(definition, replies = {}) {
  const host = fakeHost({ hello, ...replies });
  const errors = [];
  const runtime = createHostRuntime(host.transport, { onError: (e) => errors.push(e) });
  await runtime.definePlugin(definition);
  return { host, runtime, errors };
}

describe("createHostRuntime", () => {
  test("says hello, activates, subscribes and reports ready with what it registered", async () => {
    let activatedWith;
    const { host, runtime } = await started({
      activate: (ardia) => {
        activatedWith = ardia.settings.get("greeting");
      },
      commands: { greet: () => "hi" },
      tools: { echo: (input) => input },
      views: { sidebar: () => null },
      omnibox: () => [],
      decide: { "tab.opening": () => null },
      events: { "tab.activated": () => {} },
    });
    await settle();
    assert.equal(host.sent[0].method, "hello");
    assert.equal(host.sent[0].params.protocol, 2);
    assert.equal(activatedWith, "Hi");
    assert.deepEqual(runtime.ardia.plugin, { name: "v2-test", app: "Ardia", version: "0.2.47", protocol: 2 });
    assert.deepEqual(host.calls("subscribe")[0].params, { events: ["tab.activated"] });
    assert.deepEqual(host.calls("ready")[0].params, {
      commands: ["greet"],
      tools: ["echo"],
      views: ["sidebar"],
      omnibox: true,
      decide: ["tab.opening"],
      events: ["tab.activated"],
    });
  });

  test("answers tool, command, omnibox and decide calls, and passes errors back", async () => {
    const { host, runtime } = await started({
      tools: { echo: async (input, call) => ({ input, kind: call.kind }), fail: () => Promise.reject(new Error("nope")) },
      commands: { "open-thing": (input, call) => ({ ran: call.name, tab: call.context.tabId }) },
      omnibox: (query) => [{ title: `Search ${query}`, url: `https://example.com/?q=${query}`, extra: 1 }, { title: "bad" }],
      decide: { "tab.opening": (data) => (data.url.includes("blocked") ? { cancel: true } : null) },
    });
    runtime.ardia.omnibox.register(() => [{ title: "Second", url: "https://second.example", badge: "2" }]);
    host.push({ call: "c1", tool: "echo", input: { a: 1 } });
    host.push({ call: "c2", kind: "command", name: "open-thing", input: {}, context: { tabId: "t9" } });
    host.push({ call: "c3", kind: "omnibox", name: "default", input: { query: "ardia" } });
    host.push({ call: "c4", kind: "decide", name: "tab.opening", input: { url: "https://blocked.example" } });
    host.push({ call: "c5", tool: "fail" });
    host.push({ call: "c6", tool: "missing" });
    await settle(8);
    assert.deepEqual(host.resultFor("c1"), { call: "c1", result: { input: { a: 1 }, kind: "tool" } });
    assert.deepEqual(host.resultFor("c2").result, { ran: "open-thing", tab: "t9" });
    assert.deepEqual(host.resultFor("c3").result, [
      { title: "Search ardia", url: "https://example.com/?q=ardia" },
      { title: "Second", url: "https://second.example", badge: "2" },
    ]);
    assert.deepEqual(host.resultFor("c4").result, { cancel: true });
    assert.deepEqual(host.resultFor("c5"), { call: "c5", error: "nope" });
    assert.match(host.resultFor("c6").error, /no tool missing/);
  });

  test("answers the lines the host writes today: command, provider and query, event and data", async () => {
    const { host } = await started({
      commands: { "open-thing": (input, call) => ({ input: input ?? null, ran: call.name, tab: call.context.tabId, caller: call.caller, deadline: call.deadline }) },
      omnibox: (query, call) => [{ title: `${call.name} ${query}`, url: "https://example.com/" }],
      decide: { "tab.opening": (data, call) => (data.url.includes("blocked") && call.kind === "decide" ? { cancel: true } : null) },
    });
    host.push({ call: "h1", kind: "command", command: "open-thing", context: { tabId: "t9", windowId: "w1" }, caller: { kind: "command" }, deadline: 60000 });
    host.push({ call: "h2", kind: "omnibox", provider: "gh", query: "ardia", caller: { kind: "host" }, deadline: 300 });
    host.push({ call: "h3", kind: "decide", event: "tab.opening", data: { url: "https://blocked.example/" }, caller: { kind: "host" }, deadline: 250 });
    host.push({ call: "h4", kind: "decide", event: "tab.opening", data: { url: "https://fine.example/" }, caller: { kind: "host" }, deadline: 250 });
    await settle(8);
    assert.deepEqual(host.resultFor("h1").result, { input: null, ran: "open-thing", tab: "t9", caller: { kind: "command" }, deadline: 60000 });
    assert.deepEqual(host.resultFor("h2").result, [{ title: "gh ardia", url: "https://example.com/" }]);
    assert.deepEqual(host.resultFor("h3"), { call: "h3", result: { cancel: true } });
    assert.deepEqual(host.resultFor("h4"), { call: "h4", result: null });
  });

  test("a cancelled call signals the handler and sends no result", async () => {
    let signal;
    let finish;
    const { host } = await started({
      tools: {
        slow: (_input, call) =>
          new Promise((resolve) => {
            signal = call.signal;
            finish = resolve;
          }),
      },
    });
    host.push({ call: "c1", tool: "slow" });
    await settle();
    let heard = false;
    signal.onCancel(() => (heard = true));
    host.push({ call: "c1", cancel: true });
    finish("late");
    await settle();
    assert.equal(heard, true);
    assert.equal(signal.cancelled, true);
    assert.equal(host.resultFor("c1"), undefined);
  });

  test("mounts a surface, renders it, dispatches its events and unmounts it", async () => {
    const cleanups = [];
    function Sidebar({ context }) {
      const surface = useSurface();
      const [count, setCount] = useState(0);
      useEffect(() => () => cleanups.push(surface.surfaceId), []);
      return jsx(SidebarView, {
        title: `${context.title} ${count}`,
        children: jsx(SidebarView.Item, {
          title: "Bump",
          onPress: () => setCount((c) => c + 1),
          actions: jsx(ActionPanel, { children: jsx(Action, { title: "Close", onAction: () => surface.close() }) }),
        }),
      });
    }
    const { host } = await started({ views: { sidebar: Sidebar } });
    host.push({ surface: "mount", surfaceId: "s1", viewId: "sidebar", kind: "sidebar", context: { title: "Hello" } });
    await settle();
    let tree = host.renders("s1").at(-1);
    assert.equal(tree.type, "SidebarView");
    assert.equal(tree.props.title, "Hello 0");
    const item = findNode(tree, byType("SidebarItem"));
    host.push({ surface: "event", surfaceId: "s1", handlerId: item.props.onPress.__handler, args: [] });
    await settle();
    tree = host.renders("s1").at(-1);
    assert.equal(tree.props.title, "Hello 1");
    const close = findNode(tree, byType("Action", "Close"));
    host.push({ surface: "event", surfaceId: "s1", handlerId: close.props.onAction.__handler, args: [] });
    await settle();
    assert.deepEqual(host.calls("surface.close")[0].params, { surfaceId: "s1" });
    host.push({ surface: "unmount", surfaceId: "s1" });
    await settle();
    assert.deepEqual(cleanups, ["s1"]);
  });

  test("an unknown view renders a helpful empty state, and stray events are reported", async () => {
    const { host, errors } = await started({});
    host.push({ surface: "mount", surfaceId: "s2", viewId: "nope", kind: "popover" });
    host.push({ surface: "event", surfaceId: "ghost", handlerId: "h1", args: [] });
    await settle();
    const tree = host.renders("s2").at(-1);
    assert.equal(tree.type, "EmptyState");
    assert.match(tree.props.description, /nope/);
    assert.match(errors.at(-1).message, /ghost/);
  });

  test("settings come from hello, update on plugin.values and notify listeners", async () => {
    const changes = [];
    const { host, runtime } = await started({ onSettingsChange: (values) => changes.push(values.greeting) });
    assert.equal(runtime.ardia.settings.get("greeting"), "Hi");
    assert.equal(runtime.ardia.settings.get("missing", 5), 5);
    host.push({ event: "plugin.values", data: { values: { greeting: "Yo" } } });
    await settle();
    assert.equal(runtime.ardia.settings.get("greeting"), "Yo");
    assert.equal(runtime.ardia.settings.all().loud, false);
    assert.deepEqual(changes, ["Yo"]);
  });

  test("browser events reach listeners, and new listeners re-subscribe", async () => {
    const seen = [];
    const { host, runtime } = await started({ events: { "tab.activated": (data, event) => seen.push([event.name, data.tabId]) } });
    host.push({ event: "tab.activated", time: 1, data: { tabId: "t1" } });
    const off = runtime.ardia.hooks.on("tab.closed", (data) => seen.push(["closed", data.tabId]));
    await settle();
    assert.deepEqual(host.calls("subscribe").at(-1).params, { events: ["tab.activated", "tab.closed"] });
    host.push({ event: "tab.closed", data: { tabId: "t2" } });
    await settle();
    assert.deepEqual(seen, [["tab.activated", "t1"], ["closed", "t2"]]);
    off.dispose();
    await settle();
    assert.deepEqual(host.calls("subscribe").at(-1).params, { events: ["tab.activated"] });
  });

  test("a lone wildcard listener subscribes to every hook", async () => {
    const seen = [];
    const { host, runtime } = await started({});
    runtime.ardia.hooks.on("*", (data, event) => seen.push([event.name, data.tabId]));
    await settle();
    assert.deepEqual(host.calls("subscribe").at(-1).params, { events: ["*"] });
    host.push({ event: "tab.closed", data: { tabId: "t3" } });
    await settle();
    assert.deepEqual(seen, [["tab.closed", "t3"]]);
  });

  test("a call cancelled before activation finishes never runs and sends no result", async () => {
    let releaseHello;
    const host = fakeHost({ hello });
    const send = host.transport.send;
    const held = [];
    host.transport.send = (line) => {
      if (JSON.parse(line).method === "hello" && !releaseHello) {
        held.push(line);
        releaseHello = () => held.splice(0).forEach(send);
        return;
      }
      send(line);
    };
    let ran = 0;
    const runtime = createHostRuntime(host.transport, { onError: () => {} });
    const ready = runtime.definePlugin({ tools: { slow: () => ran++ } });
    host.push({ call: "c1", tool: "slow" });
    host.push({ call: "c1", cancel: true });
    host.push({ call: "c2", tool: "slow" });
    await settle();
    releaseHello();
    await ready;
    await runtime.whenIdle();
    await settle();
    assert.equal(ran, 1);
    assert.equal(host.resultFor("c1"), undefined);
    assert.deepEqual(host.resultFor("c2"), { call: "c2", result: 0 });
  });

  test("page messages reach listeners and posts go back to the view", async () => {
    const got = [];
    const { host, runtime } = await started({ onPageMessage: (message, view) => got.push([view, message]) });
    host.push({ pageMessage: { hello: true }, view: "panel" });
    await settle();
    assert.deepEqual(got, [["panel", { hello: true }]]);
    await runtime.ardia.pages.post("panel", { reply: 1 });
    assert.deepEqual(host.calls("page.post")[0].params, { view: "panel", message: { reply: 1 } });
  });

  test("ui, storage, secrets, tabs and net calls map host replies", async () => {
    const items = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const { runtime } = await started(
      {},
      {
        "ui.showQuickPick": (p) => ({ picked: p.options.canPickMany ? ["a", "b"] : ["b"] }),
        "ui.showInputBox": { value: "typed" },
        "ui.showConfirm": { confirmed: true },
        "storage.get": { found: true, value: { n: 1 } },
        "storage.keys": { keys: ["k1", 3] },
        "secrets.get": { value: "token" },
        windows: [{ id: "w1", kind: "normal", focused: true, profile: "p", profileName: "P", tabs: [{ id: "t1", url: "https://a", title: "A", profile: "p", active: true, pinned: false, group: null }] }],
        "net.fetch": (req) => ({ ok: true, status: 200, statusText: "OK", url: req.url, headers: {}, body: JSON.stringify({ stars: 9 }) }),
        "ui.showToast": () => {
          throw Object.assign(new Error("toasts are off"), { code: "refused" });
        },
      },
    );
    const { ardia } = runtime;
    assert.deepEqual(await ardia.ui.quickPick(items), items[1]);
    assert.deepEqual(await ardia.ui.quickPick(items, { canPickMany: true }), items);
    assert.equal(await ardia.ui.inputBox({ title: "Name" }), "typed");
    assert.equal(await ardia.ui.confirm({ title: "Sure?" }), true);
    assert.deepEqual(await ardia.storage.get("k"), { n: 1 });
    assert.deepEqual(await ardia.storage.keys(), ["k1"]);
    assert.equal(await ardia.secrets.get("token"), "token");
    assert.deepEqual((await ardia.tabs.query({ active: true })).map((t) => [t.id, t.windowId]), [["t1", "w1"]]);
    const res = await ardia.net.fetch("https://api.github.com/repos/x/y", { headers: { accept: "json" } });
    assert.deepEqual(res.json(), { stars: 9 });
    await assert.rejects(ardia.ui.toast("hi"), (error) => error instanceof PluginError && error.code === "refused" && /toasts are off/.test(error.message));
  });

  test("ui, tabs, workspace, toolbar and panel calls send exactly what the host's channel reads", async () => {
    const items = [{ id: "a", title: "A" }];
    const page = { tabId: "t1", url: "https://a.example/", title: "A", text: "Hello", selection: "", lang: "en" };
    const { host, runtime } = await started(
      {},
      {
        "ui.showQuickPick": { picked: ["a"] },
        "ui.showInputBox": { value: "v" },
        "ui.showConfirm": { confirmed: false },
        "tabs.readActivePage": page,
        workspace: (p) => ({ windows: [], asked: p }),
        apply: (p) => ({ ok: true, results: p.ops.map(() => ({ ok: true })) }),
        "panel.open": (p) => ({ ok: true, windowId: "w1", tabId: `panel-${p.panelId}` }),
        "panel.close": { ok: true, windowId: "w1" },
      },
    );
    const { ardia } = runtime;
    await ardia.ui.quickPick(items, { title: "Pick", placeholder: "Search" });
    assert.deepEqual(host.calls("ui.showQuickPick")[0].params, { items, options: { title: "Pick", placeholder: "Search" } });
    await ardia.ui.inputBox({ title: "Name", value: "x" });
    assert.deepEqual(host.calls("ui.showInputBox")[0].params, { options: { title: "Name", value: "x" } });
    assert.equal(await ardia.ui.confirm({ title: "Sure?", destructive: true }), false);
    assert.deepEqual(host.calls("ui.showConfirm")[0].params, { options: { title: "Sure?", destructive: true } });
    await ardia.ui.toast("Saved");
    await ardia.ui.toast("Closed 2 tabs", "Both were idle", { icon: "xmark.circle" });
    assert.deepEqual(host.calls("ui.showToast").map((m) => m.params), [
      { title: "Saved", options: {} },
      { title: "Closed 2 tabs", message: "Both were idle", options: { icon: "xmark.circle" } },
    ]);
    assert.deepEqual(await ardia.tabs.activePage(), page);
    assert.deepEqual(host.calls("tabs.readActivePage")[0].params, {});
    await ardia.tabs.close("t2");
    await ardia.tabs.activate("t3");
    await ardia.workspace.apply([{ op: "tab.mute", tabs: ["t4"] }]);
    assert.deepEqual(host.calls("apply").map((m) => m.params), [
      { ops: [{ op: "tab.close", tabs: ["t2"] }] },
      { ops: [{ op: "tab.activate", tab: "t3" }] },
      { ops: [{ op: "tab.mute", tabs: ["t4"] }] },
    ]);
    assert.deepEqual(await ardia.workspace.snapshot({ window: "w1" }), { windows: [], asked: { window: "w1" } });
    assert.deepEqual(host.calls("workspace")[0].params, { window: "w1" });
    await ardia.toolbar.update("showcase", { badge: "12", tone: "accent" });
    assert.deepEqual(host.calls("toolbar.update")[0].params, { itemId: "showcase", update: { badge: "12", tone: "accent" } });
    assert.deepEqual(await ardia.panels.open("sidecar"), { ok: true, windowId: "w1", tabId: "panel-sidecar" });
    await ardia.panels.close("sidecar");
    assert.deepEqual(host.calls("panel.open")[0].params, { panelId: "sidecar" });
    assert.deepEqual(host.calls("panel.close")[0].params, { panelId: "sidecar" });
    const sent = new Set(host.sent.map((m) => m.method));
    for (const gone of ["tabs.close", "tabs.activate", "tabs.activePage", "workspace.apply", "ui.toast", "ui.quickPick"]) assert.equal(sent.has(gone), false, gone);
  });

  test("commands.run sends the host's window and tab keys", async () => {
    const { host, runtime } = await started({}, { run: { ok: true } });
    await runtime.ardia.commands.run("reload", { windowId: "w1", tabId: "t1" });
    await runtime.ardia.commands.run("open", { arg: "x" });
    const [first, second] = host.calls("run").map((m) => m.params);
    assert.deepEqual(first, { command: "reload", window: "w1", tab: "t1" });
    assert.equal("windowId" in first, false);
    assert.equal("tabId" in first, false);
    assert.deepEqual(second, { command: "open", arg: "x" });
  });

  test("ardia.programs asks the host about the plugin's own programs and relinks them", async () => {
    const status = { state: "failed", linked: [], failed: [{ name: "tool", reason: "taken" }], binDir: "/home/.local/bin" };
    const { host, runtime } = await started({}, { "programs.status": () => status, "programs.relink": () => ({ ok: true }) });
    assert.deepEqual(await runtime.ardia.programs.status(), status);
    assert.deepEqual(await runtime.ardia.programs.relink(), { ok: true });
    assert.equal(host.calls("programs.status").length, 1);
    assert.equal(host.calls("programs.relink").length, 1);
  });

  test("storage.get reads the found envelope and keeps stored objects intact", async () => {
    const replies = { a: { found: true, value: { value: 1, other: 2 } }, b: { found: true, value: null }, c: { found: false } };
    const { runtime } = await started({}, { "storage.get": (p) => replies[p.key] });
    assert.deepEqual(await runtime.ardia.storage.get("a"), { value: 1, other: 2 });
    assert.equal(await runtime.ardia.storage.get("b"), null);
    assert.equal(await runtime.ardia.storage.get("c"), undefined);
  });

  test("a subscription the host didn't take is sent again on the next sync, and an acknowledged one isn't", async () => {
    let failures = 1;
    const { host, runtime, errors } = await started(
      { events: { "tab.activated": () => {} } },
      {
        subscribe: () => {
          if (failures-- > 0) throw new Error("busy");
          return { ok: true };
        },
      },
    );
    await settle();
    assert.equal(host.calls("subscribe").length, 1);
    assert.match(errors.at(-1).message, /busy/);
    runtime.ardia.hooks.on("tab.activated", () => {});
    await settle();
    assert.equal(host.calls("subscribe").length, 2);
    assert.deepEqual(host.calls("subscribe")[1].params, { events: ["tab.activated"] });
    runtime.ardia.hooks.on("tab.activated", () => {});
    await settle();
    assert.equal(host.calls("subscribe").length, 2);
  });

  test("subscription changes made while one is in flight wait for its reply and then send only the newest set", async () => {
    const releases = [];
    const { host, runtime } = await started({}, { subscribe: () => new Promise((resolve) => releases.push(() => resolve({ ok: true }))) });
    runtime.ardia.hooks.on("a", () => {});
    await settle();
    runtime.ardia.hooks.on("b", () => {});
    await settle();
    runtime.ardia.hooks.on("c", () => {});
    await settle();
    assert.deepEqual(host.calls("subscribe").map((m) => m.params.events), [["a"]]);
    releases.shift()();
    await settle();
    assert.deepEqual(host.calls("subscribe").map((m) => m.params.events), [["a"], ["a", "b", "c"]]);
    releases.shift()();
    await settle();
    assert.equal(host.calls("subscribe").length, 2);
  });

  test("when activate fails, queued calls get an error back and their handlers never run", async () => {
    let fail;
    let ran = 0;
    const host = fakeHost({ hello });
    const runtime = createHostRuntime(host.transport, { onError: () => {} });
    const ready = runtime.definePlugin({
      activate: () => new Promise((_, reject) => (fail = () => reject(new Error("no token")))),
      tools: { t: () => ran++ },
    });
    host.push({ call: "c1", tool: "t" });
    await settle();
    fail();
    await assert.rejects(ready, /no token/);
    await runtime.whenIdle();
    await settle();
    assert.equal(ran, 0);
    assert.match(host.resultFor("c1").error, /no token/);
    assert.equal(host.calls("ready").length, 0);
  });

  test("stopping while activate is pending disposes what it returns late and runs no queued work", async () => {
    let finish;
    let disposed = 0;
    const host = fakeHost({ hello });
    const runtime = createHostRuntime(host.transport, { onError: () => {} });
    const ready = runtime.definePlugin({
      activate: () => new Promise((resolve) => (finish = resolve)),
      views: { v: () => jsx(Text, { children: "x" }) },
      events: { "tab.activated": () => {} },
    });
    await settle();
    host.push({ surface: "mount", surfaceId: "s1", viewId: "v", kind: "panel" });
    host.push({ event: "plugin.stopping" });
    await settle();
    finish({ dispose: () => disposed++ });
    await ready;
    await runtime.whenIdle();
    await settle();
    assert.equal(disposed, 1);
    assert.equal(host.calls("ready").length, 0);
    assert.equal(host.calls("subscribe").length, 0);
    assert.equal(host.renders("s1").length, 0);
    assert.equal(runtime.surfaceCount(), 0);
  });

  test("dispose rejects requests still waiting on the host, refuses new ones and deactivates once", async () => {
    let deactivated = 0;
    const { host, runtime } = await started({ deactivate: () => deactivated++ }, { values: SILENT });
    const refresh = runtime.ardia.settings.refresh();
    await settle();
    host.push({ event: "plugin.stopping" });
    await settle();
    await runtime.dispose();
    assert.match(String(await outcome(refresh)), /stopped/);
    assert.match(String(await outcome(runtime.request("windows"))), /stopped/);
    await runtime.dispose();
    assert.equal(deactivated, 1);
  });

  test("a result that can't be encoded comes back as an error for the same call; a broken pipe isn't retried", async () => {
    const { host, errors } = await started({ tools: { big: () => 1n, fine: () => 1 } });
    host.push({ call: "c1", tool: "big" });
    await settle(8);
    assert.match(host.resultFor("c1").error, /BigInt/);
    const send = host.transport.send;
    let attempts = 0;
    host.transport.send = (line) => {
      if (JSON.parse(line).method === "result") {
        attempts++;
        throw new Error("pipe closed");
      }
      send(line);
    };
    host.push({ call: "c2", tool: "fine" });
    await settle(8);
    assert.equal(attempts, 1);
    assert.match(errors.at(-1).message, /pipe closed/);
  });

  test("when the host refuses the newest render, the view is replaced with an error instead of left stale", async () => {
    let refuse = false;
    function Toggle() {
      const [on, setOn] = useState(true);
      return jsx(Box, { children: on ? jsx(Button, { title: "Hide", onPress: () => setOn(false) }) : jsx(Text, { children: "gone" }) });
    }
    const { host, errors } = await started(
      { views: { v: Toggle } },
      {
        "surface.render": () => {
          if (!refuse) return { ok: true };
          refuse = false;
          throw new Error("bad tree");
        },
      },
    );
    host.push({ surface: "mount", surfaceId: "s1", viewId: "v", kind: "panel" });
    await settle();
    const button = findNode(host.renders("s1").at(-1), byType("Button"));
    refuse = true;
    host.push({ surface: "event", surfaceId: "s1", handlerId: button.props.onPress.__handler, args: [] });
    await settle(8);
    const trees = host.renders("s1");
    assert.equal(trees.length, 3);
    assert.equal(trees.at(-1).type, "EmptyState");
    assert.match(trees.at(-1).props.description, /bad tree/);
    assert.match(errors.at(-1).message, /bad tree/);
  });

  test("a refused render that a newer render already replaced leaves the newer tree alone", async () => {
    const held = [];
    let bump;
    function Counter() {
      const [n, setN] = useState(0);
      bump = () => setN((v) => v + 1);
      return jsx(Text, { children: String(n) });
    }
    const { host } = await started(
      { views: { v: Counter } },
      {
        "surface.render": (params) =>
          params.tree.children[0] === "1" ? new Promise((_, reject) => held.push(() => reject(new Error("late refusal")))) : { ok: true },
      },
    );
    host.push({ surface: "mount", surfaceId: "s1", viewId: "v", kind: "panel" });
    await settle();
    bump();
    await settle();
    bump();
    await settle();
    held.shift()();
    await settle();
    assert.deepEqual(host.renders("s1").map((tree) => tree.children[0]), ["0", "1", "2"]);
  });

  test("remounting a surface id gives its handlers new ids, so a late event for the old mount can't reach the new one", async () => {
    const pressed = [];
    function Named({ context }) {
      return jsx(Button, { title: context.name, onPress: () => pressed.push(context.name) });
    }
    const { host } = await started({ views: { v: Named } });
    host.push({ surface: "mount", surfaceId: "s1", viewId: "v", kind: "panel", context: { name: "old" } });
    await settle();
    const oldId = host.renders("s1").at(-1).props.onPress.__handler;
    host.push({ surface: "mount", surfaceId: "s1", viewId: "v", kind: "panel", context: { name: "new" } });
    await settle();
    const newId = host.renders("s1").at(-1).props.onPress.__handler;
    assert.notEqual(newId, oldId);
    host.push({ surface: "event", surfaceId: "s1", handlerId: oldId, args: [] });
    await settle();
    assert.deepEqual(pressed, []);
    host.push({ surface: "event", surfaceId: "s1", handlerId: newId, args: [] });
    await settle();
    assert.deepEqual(pressed, ["new"]);
  });

  test("quickPick decodes the reply in the mode it sent, even if the options change while it waits", async () => {
    const items = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const { runtime } = await started({}, { "ui.showQuickPick": { picked: ["a"] } });
    const options = { canPickMany: false };
    const picking = runtime.ardia.ui.quickPick(items, options);
    options.canPickMany = true;
    assert.deepEqual(await picking, items[0]);
  });

  test("stopping cancels running calls, forgets queued ones and admits no new calls", async () => {
    let signal;
    const { host, runtime } = await started({
      tools: {
        wait: (_input, call) =>
          new Promise(() => {
            signal = call.signal;
          }),
        quick: () => 1,
      },
    });
    host.push({ call: "c1", tool: "wait" });
    await settle();
    assert.equal(runtime.callCount(), 1);
    host.push({ event: "plugin.stopping" });
    await settle();
    assert.equal(signal.cancelled, true);
    assert.equal(runtime.callCount(), 0);
    host.push({ call: "c2", tool: "quick" });
    await settle();
    assert.equal(runtime.callCount(), 0);
    assert.equal(host.resultFor("c2"), undefined);
  });

  function heldHello() {
    const host = fakeHost({ hello });
    const send = host.transport.send;
    const held = [];
    host.transport.send = (line) => {
      if (JSON.parse(line).method === "hello") return void held.push(line);
      send(line);
    };
    return { host, releaseHello: () => held.splice(0).forEach(send) };
  }

  test("a call queued behind activation is forgotten when the plugin stops before activating", async () => {
    const { host, releaseHello } = heldHello();
    let ran = 0;
    const runtime = createHostRuntime(host.transport, { onError: () => {} });
    const ready = runtime.definePlugin({ tools: { t: () => ran++ } });
    host.push({ call: "c1", tool: "t" });
    host.push({ event: "plugin.stopping" });
    await settle();
    releaseHello();
    await ready;
    await runtime.whenIdle();
    await settle();
    assert.equal(ran, 0);
    assert.equal(runtime.callCount(), 0);
  });

  test("a plugin stopped while hello is pending never activates or takes the hello state", async () => {
    const { host, releaseHello } = heldHello();
    let activated = 0;
    const runtime = createHostRuntime(host.transport, { onError: () => {} });
    const ready = runtime.definePlugin({ activate: () => void activated++, events: { "tab.activated": () => {} } });
    host.push({ event: "plugin.stopping" });
    await settle();
    releaseHello();
    await ready;
    await settle();
    assert.equal(activated, 0);
    assert.equal(runtime.ardia.plugin.name, "");
    assert.equal(host.calls("ready").length, 0);
    assert.equal(host.calls("subscribe").length, 0);
  });

  test("a host reply refusing a result with the unencodable code isn't mistaken for a local encoding failure", async () => {
    const { host, errors } = await started(
      { tools: { fine: () => 1 } },
      {
        result: () => {
          throw Object.assign(new Error("host refused"), { code: "unencodable" });
        },
      },
    );
    host.push({ call: "c1", tool: "fine" });
    await settle(8);
    assert.equal(host.calls("result").length, 1);
    assert.match(errors.at(-1).message, /host refused/);
  });

  test("dispose lets deactivate make calls, but stops waiting on a hung one when the grace period ends", async () => {
    let answered = null;
    const quick = await started({ deactivate: async () => (answered = await quick.runtime.request("windows")) }, { windows: [] });
    assert.equal(await outcome(quick.runtime.dispose(), 300), "resolved");
    assert.deepEqual(answered, []);
    let refresh;
    const host = fakeHost({ hello, values: SILENT });
    const runtime = createHostRuntime(host.transport, { onError: () => {}, stopGraceMs: 30 });
    await runtime.definePlugin({
      deactivate: async () => {
        refresh = runtime.ardia.settings.refresh();
        await refresh;
      },
    });
    assert.equal(await outcome(runtime.dispose(), 300), "resolved");
    assert.match(String(await outcome(refresh)), /stopped/);
  });

  test("when both the refused render and its error view fail to send, the buttons the host still shows keep working", async () => {
    const log = [];
    function Pair() {
      const [showB, setShowB] = useState(true);
      return jsx(Box, {
        children: [
          jsx(Button, { key: "remove", title: "Remove B", onPress: () => setShowB(false) }),
          showB ? jsx(Button, { key: "b", title: "B", onPress: () => log.push("b") }) : null,
        ],
      });
    }
    let refuse = false;
    const { host, errors } = await started(
      { views: { v: Pair } },
      {
        "surface.render": () => {
          if (refuse) throw new Error("host busy");
          return { ok: true };
        },
      },
    );
    host.push({ surface: "mount", surfaceId: "s1", viewId: "v", kind: "panel" });
    await settle();
    const shown = host.renders("s1").at(-1);
    const remove = findNode(shown, byType("Button", "Remove B")).props.onPress.__handler;
    const b = findNode(shown, byType("Button", "B")).props.onPress.__handler;
    refuse = true;
    host.push({ surface: "event", surfaceId: "s1", handlerId: remove, args: [] });
    await settle(8);
    assert.equal(host.renders("s1").length, 3);
    assert.equal(host.renders("s1").at(-1).type, "EmptyState");
    const before = errors.length;
    host.push({ surface: "event", surfaceId: "s1", handlerId: b, args: [] });
    await settle();
    assert.deepEqual(log, ["b"]);
    assert.equal(errors.length, before);
  });

  test("an error view the host accepts retires the handlers of the tree it replaced", async () => {
    const log = [];
    function Pair() {
      const [showB, setShowB] = useState(true);
      return jsx(Box, {
        children: [
          jsx(Button, { key: "remove", title: "Remove B", onPress: () => setShowB(false) }),
          showB ? jsx(Button, { key: "b", title: "B", onPress: () => log.push("b") }) : null,
        ],
      });
    }
    let refuseNext = false;
    const { host, errors } = await started(
      { views: { v: Pair } },
      {
        "surface.render": () => {
          if (!refuseNext) return { ok: true };
          refuseNext = false;
          throw new Error("bad tree");
        },
      },
    );
    host.push({ surface: "mount", surfaceId: "s1", viewId: "v", kind: "panel" });
    await settle();
    const shown = host.renders("s1").at(-1);
    const remove = findNode(shown, byType("Button", "Remove B")).props.onPress.__handler;
    const b = findNode(shown, byType("Button", "B")).props.onPress.__handler;
    refuseNext = true;
    host.push({ surface: "event", surfaceId: "s1", handlerId: remove, args: [] });
    await settle(8);
    assert.equal(host.renders("s1").at(-1).type, "EmptyState");
    host.push({ surface: "event", surfaceId: "s1", handlerId: b, args: [] });
    await settle();
    assert.deepEqual(log, []);
    assert.match(errors.at(-1).message, /no handler/);
  });

  test("a transport that throws a PluginError coded unencodable isn't mistaken for a local encoding failure", async () => {
    const { host, errors } = await started({ tools: { fine: () => 1 } });
    const send = host.transport.send;
    let attempts = 0;
    host.transport.send = (line) => {
      if (JSON.parse(line).method === "result") {
        attempts++;
        throw new PluginError("unencodable", "transport says no");
      }
      send(line);
    };
    host.push({ call: "c1", tool: "fine" });
    await settle(8);
    assert.equal(attempts, 1);
    assert.match(errors.at(-1).message, /transport says no/);
  });

  test("net.fetch reports ok from the HTTP status and turns a transport failure into an error", async () => {
    const { runtime } = await started(
      {},
      {
        "net.fetch": (req) => {
          if (req.url.includes("down")) return { ok: false, reason: "the host couldn't be reached" };
          const status = req.url.includes("missing") ? 404 : 200;
          return { ok: true, status, statusText: status === 404 ? "Not Found" : "OK", url: req.url, headers: {}, body: status === 404 ? "nope" : "{}" };
        },
      },
    );
    const missing = await runtime.ardia.net.fetch("https://api.example.com/missing");
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
    assert.equal(missing.text(), "nope");
    assert.equal((await runtime.ardia.net.fetch("https://api.example.com/fine")).ok, true);
    await assert.rejects(runtime.ardia.net.fetch("https://down.example.com/"), (error) => error instanceof PluginError && /couldn't be reached/.test(error.message));
  });

  test("quickPick resolves the reply against the items it sent, even if the caller changes them while it waits", async () => {
    const { runtime } = await started({}, { "ui.showQuickPick": { picked: ["a"] } });
    const replaced = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const picking = runtime.ardia.ui.quickPick(replaced);
    replaced[0] = { id: "a", title: "Swapped in" };
    assert.deepEqual(await picking, { id: "a", title: "A" });
    const removed = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const pickingMany = runtime.ardia.ui.quickPick(removed, { canPickMany: true });
    removed.splice(0, 1);
    assert.deepEqual(await pickingMany, [{ id: "a", title: "A" }]);
  });

  test("quickPick matches the reply against a snapshot of the items, even if the caller changes an item's id in place", async () => {
    const { runtime } = await started({}, { "ui.showQuickPick": { picked: ["a"] } });
    const items = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const picking = runtime.ardia.ui.quickPick(items);
    items[0].id = "renamed";
    items[0].title = "Renamed";
    assert.deepEqual(await picking, { id: "a", title: "A" });
  });

  test("a malformed host error still rejects the request it answers", async () => {
    const { host, runtime } = await started({}, { windows: SILENT });
    const pending = runtime.request("windows");
    await settle();
    host.push({ id: host.calls("windows")[0].id, error: { code: 7, message: { toString: 1 } } });
    const settled = await outcome(pending);
    assert.ok(settled instanceof PluginError, String(settled));
    assert.equal(settled.code, "failed");
    assert.match(settled.message, /refused/);
  });

  test("a deactivate or cancel listener that disposes the runtime again reuses the shutdown already running", async () => {
    let deactivated = 0;
    let runtime = null;
    const started_ = await started({
      tools: {
        wait: (_input, call) =>
          new Promise(() => {
            call.signal.onCancel(() => void runtime.dispose());
          }),
      },
      deactivate: () => {
        deactivated++;
        if (deactivated < 5) void runtime.dispose();
      },
    });
    runtime = started_.runtime;
    started_.host.push({ call: "c1", tool: "wait" });
    await settle();
    started_.host.push({ event: "plugin.stopping" });
    await settle();
    assert.equal(deactivated, 1);
  });

  test("an event that arrives before the host takes a new tree reaches the handler of the tree it still shows", async () => {
    const log = [];
    const held = [];
    function Editor() {
      const [target, setTarget] = useState("A");
      return jsx(Box, {
        children: [
          jsx(Button, { key: "edit", title: `Edit ${target}`, onPress: () => log.push(target) }),
          jsx(Button, { key: "switch", title: "Switch", onPress: () => setTarget("B") }),
        ],
      });
    }
    const { host } = await started(
      { views: { v: Editor } },
      {
        "surface.render": (params) =>
          findNode(params.tree, byType("Button", "Edit B")) ? new Promise((resolve) => held.push(() => resolve({ ok: true }))) : { ok: true },
      },
    );
    host.push({ surface: "mount", surfaceId: "s1", viewId: "v", kind: "panel" });
    await settle();
    const shown = host.renders("s1").at(-1);
    const edit = findNode(shown, byType("Button", "Edit A")).props.onPress.__handler;
    host.push({ surface: "event", surfaceId: "s1", handlerId: findNode(shown, byType("Button", "Switch")).props.onPress.__handler, args: [] });
    await settle();
    assert.equal(findNode(host.renders("s1").at(-1), byType("Button", "Edit B")).props.onPress.__handler, edit);
    host.push({ surface: "event", surfaceId: "s1", handlerId: edit, args: [] });
    await settle();
    assert.deepEqual(log, ["A"]);
    held.shift()();
    await settle();
    host.push({ surface: "event", surfaceId: "s1", handlerId: edit, args: [] });
    await settle();
    assert.deepEqual(log, ["A", "B"]);
  });

  test("a cleanup returned by activate that throws doesn't stop the other registrations or deactivate from running", async () => {
    let deactivated = 0;
    const { host, runtime, errors } = await started({
      activate: () => ({
        dispose() {
          throw new Error("watcher already closed");
        },
      }),
      commands: { save: () => "saved" },
      events: { "tab.activated": () => {} },
      deactivate: () => void deactivated++,
    });
    host.push({ event: "plugin.stopping" });
    await settle();
    assert.equal(deactivated, 1);
    assert.equal(runtime.registry.commands.size, 0);
    assert.equal(runtime.registry.events.size, 0);
    assert.ok(errors.some((error) => /watcher already closed/.test(error.message)));
  });

  test("plugin.stopping disposes registrations, closes surfaces and calls deactivate", async () => {
    let stopped = false;
    const { host, runtime } = await started({ views: { v: () => jsx(Text, { children: "x" }) }, deactivate: () => (stopped = true) });
    host.push({ surface: "mount", surfaceId: "s1", viewId: "v", kind: "panel" });
    await settle();
    assert.equal(runtime.surfaceCount(), 1);
    host.push({ event: "plugin.stopping" });
    await settle();
    assert.equal(stopped, true);
    assert.equal(runtime.surfaceCount(), 0);
    assert.equal(runtime.registry.views.size, 0);
  });
});

describe("v2-showcase fixture", () => {
  const fixture = (path) => new URL(`../../../tests/fixtures/plugins/v2-showcase/${path}`, import.meta.url);

  test("its plugin.json reads and passes the app's checks with no problems", async () => {
    const { readManifest } = await import("../../../apps/browser/src/lib/pluginManifest.ts");
    const { appProblems } = await import("../../../apps/browser/src/state/plugins/appChecks.ts");
    const { useBrowser } = await import("../../../apps/browser/src/state/browser/store.ts");
    const read = readManifest(readFileSync(fixture("plugin.json"), "utf8"));
    assert.deepEqual(read.problems, []);
    assert.deepEqual(appProblems(read.manifest, useBrowser.getState().settings, "99.0.0"), []);
    assert.equal(read.manifest.name, "v2-showcase");
    assert.deepEqual(read.manifest.hooks, ["tab.opening", "tab.activated", "tab.opened", "tab.closed"]);
    assert.equal(read.manifest.permissions.workspace, true);
  });

  test("its bundle carries no comments and speaks the host's method names", () => {
    const bundle = readFileSync(fixture("dist/index.js"), "utf8");
    assert.equal(/^\s*\/\/ |\/\*/m.test(bundle), false);
    for (const method of ["tabs.readActivePage", "ui.showToast", "ui.showQuickPick", "toolbar.update", "panel.open"]) assert.ok(bundle.includes(`"${method}"`), method);
    assert.equal(bundle.includes('"tabs.close"'), false);
  });

  test("its committed bundle is what build.mjs makes from today's SDK", () => {
    const scratch = mkdtempSync(join(tmpdir(), "v2-showcase-"));
    try {
      const out = join(scratch, "index.js");
      const built = spawnSync(process.execPath, [fileURLToPath(fixture("build.mjs")), out], { encoding: "utf8" });
      assert.equal(built.status, 0, built.stderr);
      assert.equal(readFileSync(fixture("dist/index.js"), "utf8"), readFileSync(out, "utf8"), "run node tests/fixtures/plugins/v2-showcase/build.mjs and commit dist/index.js");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

test("a rejected promise returned by an async effect reaches the surface error handler", async () => {
  function Boot() {
    useEffect(async () => {
      throw new Error("initialization failed");
    }, []);
    return jsx(Text, { children: "ready" });
  }
  const { errors } = mount(Boot);
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "initialization failed");
});
