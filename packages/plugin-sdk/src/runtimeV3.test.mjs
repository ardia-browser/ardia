import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CodeBlock, FileDropZone, Grid, Image, List, Table, Tabs, TagList, Text, jsx, jsxs, readServerSentEvents, useState } from "./index.ts";
import { applyTreePatch, diffTree, isTreeNode } from "./protocol.ts";
import { createChannels } from "./channels.ts";
import { createMockHost } from "./testing.ts";

const node = (type, props = {}, children = [], key) => ({ type, ...(key !== undefined ? { key } : {}), props, children });

describe("tree patches", () => {
  const cases = [
    [node("List", {}, [node("ListItem", { title: "a" }, [], "a"), node("ListItem", { title: "b" }, [], "b")]), node("List", {}, [node("ListItem", { title: "a" }, [], "a"), node("ListItem", { title: "B" }, [], "b")])],
    [node("List", {}, [node("ListItem", { title: "a" }, [], "a")]), node("List", {}, [node("ListItem", { title: "z" }, [], "z"), node("ListItem", { title: "a" }, [], "a")])],
    [node("List", {}, [node("ListItem", {}, [], "a"), node("ListItem", {}, [], "b"), node("ListItem", {}, [], "c")]), node("List", {}, [node("ListItem", {}, [], "a"), node("ListItem", {}, [], "c")])],
    [node("Box", { gap: "s", old: 1 }, ["hi", node("Text", {}, ["x"])]), node("Box", { gap: "m" }, ["hello", node("Text", {}, ["y"])])],
    [node("Box", {}, [node("Text", {}, ["x"])]), node("List", {}, [])],
    [node("Box", {}, []), node("Box", {}, ["a", "b", node("Divider")])],
    [node("Box", {}, ["a", "b", node("Divider")]), node("Box", {}, [])],
  ];
  cases.forEach(([before, after], i) => {
    test(`diffTree then applyTreePatch rebuilds the next tree (${i})`, () => {
      const frozen = JSON.parse(JSON.stringify(before));
      const ops = diffTree(before, after);
      assert.deepEqual(applyTreePatch(before, ops), after);
      assert.deepEqual(before, frozen, "applying never mutates the old tree");
    });
  });

  test("an unchanged tree has no ops, a keyed edit stays small, and bad patches throw", () => {
    const tree = cases[0][0];
    assert.deepEqual(diffTree(tree, JSON.parse(JSON.stringify(tree))), []);
    assert.deepEqual(diffTree(cases[0][0], cases[0][1]), [{ op: "props", path: [1], set: { title: "B" } }]);
    assert.deepEqual(diffTree(null, tree), [{ op: "replace", path: [], node: tree }]);
    assert.throws(() => applyTreePatch(tree, [{ op: "remove", path: [], index: 5, count: 1 }]), /Can't remove/);
    assert.throws(() => applyTreePatch(tree, [{ op: "props", path: [9] }]), /no child/);
    assert.throws(() => applyTreePatch(null, [{ op: "props", path: [] }]), /start by replacing/);
    assert.throws(() => applyTreePatch(tree, [{ op: "explode", path: [] }]), /Unknown patch op/);
  });
});

describe("tree patch hardening", () => {
  test("a prop set to undefined is removed on the other side", () => {
    const before = node("Box", { title: "x", tone: "accent" }, ["a"]);
    const after = node("Box", { title: "x", tone: undefined }, ["a"]);
    const ops = JSON.parse(JSON.stringify(diffTree(before, after)));
    assert.deepEqual(ops, [{ op: "props", path: [], unset: ["tone"] }]);
    assert.deepEqual(applyTreePatch(before, ops).props, { title: "x" });
    assert.deepEqual(diffTree(node("Box", { a: undefined }), node("Box", {})), []);
    const inserted = diffTree(node("Box", {}, []), node("Box", {}, [node("Text", { hidden: undefined, t: 1 })]));
    assert.deepEqual(inserted[0].nodes[0].props, { t: 1 });
  });

  test("malformed roots and nodes are refused", () => {
    for (const bad of [null, "text", 3, { type: "Box" }, { type: "Box", props: null, children: [] }, { type: "", props: {}, children: [] }, { type: "Box", props: {}, children: [{ type: "Text", props: {}, children: [7] }] }, { type: "Box", props: {}, children: [], extra: 1 }, { type: "Box", key: {}, props: {}, children: [] }]) {
      assert.equal(isTreeNode(bad), false, JSON.stringify(bad));
      assert.throws(() => applyTreePatch(null, [{ op: "replace", path: [], node: bad }]), /well-formed|root/);
    }
    assert.throws(() => applyTreePatch(node("Box"), [{ op: "replace", path: [], node: "text" }]), /root must be a node/);
    assert.throws(() => applyTreePatch(node("Box"), [{ op: "insert", path: [], index: 0, nodes: [{ type: "Text", props: [], children: [] }] }]), /well-formed/);
    let deep = node("Box");
    for (let i = 0; i < 300; i++) deep = node("Box", {}, [deep]);
    assert.equal(isTreeNode(deep), false);
  });

  test("sparse node and child arrays are refused", () => {
    const holes = [node("Text")];
    holes.length = 3;
    assert.throws(() => applyTreePatch(node("Box"), [{ op: "insert", path: [], index: 0, nodes: holes }]), /well-formed/);
    const parent = node("Box");
    parent.children = holes;
    assert.equal(isTreeNode(parent), false);
    assert.equal(isTreeNode(node("Box", { list: [1, , 3] })), false);
  });

  test("__proto__, constructor and prototype keys are refused everywhere", () => {
    const poisoned = JSON.parse('{"type":"Box","props":{"__proto__":{"polluted":true}},"children":[]}');
    assert.equal(isTreeNode(poisoned), false);
    assert.equal(isTreeNode(JSON.parse('{"type":"Box","props":{"style":{"constructor":{"prototype":{}}}},"children":[]}')), false);
    const tree = node("Box", { a: 1 });
    assert.throws(() => applyTreePatch(tree, JSON.parse('[{"op":"props","path":[],"set":{"__proto__":{"polluted":true}}}]')), /__proto__/);
    assert.throws(() => applyTreePatch(tree, [{ op: "props", path: [], set: { nested: { prototype: 1 } } }]), /__proto__/);
    assert.throws(() => applyTreePatch(tree, [{ op: "props", path: [], unset: ["constructor"] }]), /unset/);
    assert.throws(() => applyTreePatch(tree, [{ op: "props", path: [], set: null }]), /set must be/);
    assert.equal({}.polluted, undefined);
  });
});

describe("surface updates", () => {
  function Counter() {
    const [count, setCount] = useState(0);
    return jsx(List, {
      children: [
        jsx(List.Item, { id: "a", title: "Static" }, "a"),
        jsx(List.Item, { id: "b", title: `Count ${count}`, onSelect: () => setCount(count + 1) }, "b"),
      ],
    });
  }

  test("a protocol 3 host gets one render, then patches it can apply", async () => {
    const host = createMockHost({ protocol: 3 });
    await host.load({ views: { counter: Counter } });
    const view = await host.mountView("counter");
    assert.equal(host.requests("surface.render").length, 1);
    const item = view.find((n) => n.props.id === "b");
    await view.trigger(item, "onSelect");
    await view.trigger(view.find((n) => n.props.id === "b"), "onSelect");
    assert.equal(host.requests("surface.render").length, 1);
    const patches = host.requests("surface.patch");
    assert.equal(patches.length, 2);
    assert.deepEqual([patches[0].base, patches[0].rev, patches[1].base, patches[1].rev], [1, 2, 2, 3]);
    assert.ok(patches.every((p) => p.ops.length === 1 && p.ops[0].op === "props"));
    assert.equal(view.find((n) => n.props.id === "b").props.title, "Count 2");
    await host.dispose();
  });

  test("a protocol 2 host keeps getting whole renders", async () => {
    const host = createMockHost({ protocol: 2 });
    await host.load({ views: { counter: Counter } });
    const view = await host.mountView("counter");
    await view.trigger(view.find((n) => n.props.id === "b"), "onSelect");
    assert.equal(host.requests("surface.patch").length, 0);
    assert.equal(host.requests("surface.render").length, 2);
    assert.equal(host.requests("surface.render")[0].rev, undefined);
    assert.equal(view.text().includes("Count 1"), true);
    await host.dispose();
  });

  test("a refused patch falls back to a whole render", async () => {
    const host = createMockHost({ protocol: 3 });
    let refuse = true;
    host.respond("surface.patch", () => {
      if (refuse) {
        refuse = false;
        throw new Error("stale base");
      }
      return null;
    });
    await host.load({ views: { counter: Counter } });
    const view = await host.mountView("counter");
    await view.trigger(view.find((n) => n.props.id === "b"), "onSelect");
    assert.equal(host.requests("surface.render").length, 2);
    assert.equal(view.find((n) => n.props.id === "b").props.title, "Count 1");
    await host.dispose();
  });

  test("the v3 components serialize to their host types", async () => {
    const host = createMockHost();
    const Gallery = () =>
      jsxs(Tabs, {
        children: [
          jsx(Tabs.Tab, { id: "g", title: "Grid", children: jsx(Grid, { columns: 4, children: jsx(Grid.Section, { title: "S", children: jsx(Grid.Item, { content: "photo", title: "P" }) }) }) }),
          jsx(Tabs.Tab, { id: "t", title: "Table", children: jsx(Table, { columns: [{ id: "n", title: "Name" }], children: jsx(Table.Row, { children: jsx(Table.Cell, { column: "n", children: "x" }) }) }) }),
          jsx(CodeBlock, { code: "let a = 1", language: "ts" }),
          jsx(Image, { source: "https://example.com/a.png", alt: "A" }),
          jsx(TagList, { children: jsx(TagList.Item, { text: "tag" }) }),
          jsx(FileDropZone, { title: "Drop", onDrop: () => {} }),
          jsx(List, { children: jsx(List.Item, { title: "i", detail: jsx(List.Item.Detail, { markdown: "# hi" }) }) }),
          jsx(Text, { children: "done" }),
        ],
      });
    await host.load({ views: { gallery: Gallery } });
    const view = await host.mountView("gallery");
    const types = new Set(view.findAll(() => true).map((n) => n.type));
    for (const type of ["Tabs", "Tab", "Grid", "GridSection", "GridItem", "Table", "TableRow", "TableCell", "CodeBlock", "Image", "TagList", "TagListItem", "FileDropZone", "ListItemDetail"]) assert.ok(types.has(type), type);
    assert.equal(typeof view.byType("FileDropZone")[0].props.onDrop.__handler, "string");
    await host.dispose();
  });
});

describe("streaming and sockets", () => {
  test("fetchStream yields chunks as they arrive and parses as server-sent events", async () => {
    const host = createMockHost();
    host.mockFetchStream("https://api.example.com/chat", { status: 200, headers: { "content-type": "text/event-stream" }, chunks: ["data: hel", "lo\n\nevent: done\n", "data: [DONE]\n\n"] });
    await host.load({});
    const response = await host.ardia.net.fetchStream("https://api.example.com/chat", { method: "POST", body: "{}" });
    assert.equal(response.ok, true);
    assert.equal(response.headers["content-type"], "text/event-stream");
    const events = [];
    for await (const event of readServerSentEvents(response.body)) events.push(event);
    assert.deepEqual(events, [{ event: "message", data: "hello" }, { event: "done", data: "[DONE]" }]);
    assert.equal(host.requests("net.fetch.stream")[0].method, "POST");
    assert.equal(host.runtime.channelCount(), 0);
    await host.dispose();
  });

  test("text() collects the body; a stream error rejects it", async () => {
    const host = createMockHost();
    host.mockFetchStream("https://a.com/ok", { chunks: ["a", "b", "c"] });
    host.mockFetchStream("https://a.com/bad", { chunks: ["a"], error: "reset" });
    await host.load({});
    assert.equal(await (await host.ardia.net.fetchStream("https://a.com/ok")).text(), "abc");
    const bad = await host.ardia.net.fetchStream({ url: "https://a.com/bad" });
    await assert.rejects(bad.text(), /reset/);
    await assert.rejects(host.ardia.net.fetchStream("https://nowhere.com/"), /No mock answers/);
    await host.dispose();
  });

  test("breaking out of the body or aborting cancels the stream on the host", async () => {
    const host = createMockHost();
    host.mockFetchStream("https://a.com/", { chunks: ["1", "2", "3", "4"] });
    await host.load({});
    const response = await host.ardia.net.fetchStream("https://a.com/");
    for await (const chunk of response.body) if (chunk === "1") break;
    assert.equal(host.requests("net.fetch.cancel").length, 1);
    const controller = new AbortController();
    const second = await host.ardia.net.fetchStream("https://a.com/", { signal: controller.signal });
    const reading = second.text();
    controller.abort();
    await assert.rejects(reading);
    assert.equal(host.requests("net.fetch.cancel").length, 2);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(host.ardia.net.fetchStream("https://a.com/", { signal: aborted.signal }));
    await host.dispose();
  });

  test("connect opens a host-proxied socket and relays messages both ways", async () => {
    const host = createMockHost();
    host.respond("net.ws.connect", () => ({ open: true, protocol: "chat" }));
    await host.load({});
    const socket = await host.ardia.net.connect("wss://ws.example.com/", { protocols: ["chat"] });
    assert.equal(socket.state, "open");
    assert.equal(socket.protocol, "chat");
    const got = [];
    socket.onMessage((data) => got.push(data));
    const closed = new Promise((resolve) => socket.onClose((code, reason) => resolve([code, reason])));
    await socket.send("ping");
    assert.deepEqual(host.requests("net.ws.send")[0], { socket: socket.id, data: "ping" });
    await host.emit("net.ws.message", { socket: socket.id, data: "pong" });
    assert.deepEqual(got, ["pong"]);
    await host.emit("net.ws.close", { socket: socket.id, code: 1000, reason: "bye" });
    assert.deepEqual(await closed, [1000, "bye"]);
    assert.equal(socket.state, "closed");
    await assert.rejects(socket.send("late"), /isn't open/);
    host.respond("net.ws.connect", () => {
      throw new Error("refused: network permission");
    });
    await assert.rejects(host.ardia.net.connect("wss://nope.example.com/"), /refused/);
    await host.dispose();
  });
});

describe("channel edge cases", () => {
  const fakeRpc = (handlers) => {
    const calls = [];
    const forgotten = [];
    let next = 0;
    const start = (method, params, onId) => {
      calls.push([method, params]);
      const handler = handlers[method];
      const id = ++next;
      onId?.(id);
      return { id, done: handler ? Promise.resolve().then(() => handler(params)) : Promise.resolve(null) };
    };
    return { calls, forgotten, rpc: { start, request: (method, params) => start(method, params).done, forget: (id) => forgotten.push(id) } };
  };

  test("a stream error before the head arrives rejects fetchStream instead of stranding it", async () => {
    let release;
    const { rpc, forgotten } = fakeRpc({ "net.fetch.stream": () => new Promise((r) => (release = r)) });
    const channels = createChannels(rpc, () => {});
    const pending = channels.fetchStream("https://a.com/");
    await Promise.resolve();
    channels.deliver("net.fetch.error", { stream: "f1", message: "dns failed", code: "dns" });
    await assert.rejects(pending, /dns failed/);
    assert.deepEqual(forgotten, [1]);
    release({ status: 200, statusText: "OK", headers: {}, url: "https://a.com/" });
    assert.equal(channels.openCount(), 0);
  });

  test("an overflowing stream is cancelled on the host and forgotten", async () => {
    const { rpc, calls } = fakeRpc({ "net.fetch.stream": () => ({ status: 200, statusText: "OK", headers: {}, url: "u" }) });
    const channels = createChannels(rpc, () => {});
    const response = await channels.fetchStream("https://a.com/");
    for (let i = 0; i < 4097; i++) channels.deliver("net.fetch.chunk", { stream: "f1", data: "x" });
    await assert.rejects(response.text(), /cut off/);
    await Promise.resolve();
    assert.ok(calls.some(([m]) => m === "net.fetch.cancel"));
    assert.equal(channels.openCount(), 0);
  });

  test("closeAll cancels open streams and closes open sockets on the host", async () => {
    const { rpc, calls } = fakeRpc({ "net.fetch.stream": () => ({ status: 200, statusText: "OK", headers: {}, url: "u" }), "net.ws.connect": () => ({ open: true }) });
    const channels = createChannels(rpc, () => {});
    await channels.fetchStream("https://a.com/");
    const socket = await channels.connect("wss://a.com/");
    channels.closeAll();
    await Promise.resolve();
    assert.deepEqual(calls.filter(([m]) => m === "net.fetch.cancel" || m === "net.ws.close").map(([m]) => m).sort(), ["net.fetch.cancel", "net.ws.close"]);
    assert.equal(socket.state, "closed");
    assert.equal(channels.openCount(), 0);
  });

  test("socket events that arrive before a listener attaches are held for it", async () => {
    const { rpc } = fakeRpc({ "net.ws.connect": () => ({ open: true }) });
    const channels = createChannels(rpc, () => {});
    const socket = await channels.connect("wss://a.com/");
    channels.deliver("net.ws.message", { socket: socket.id, data: "early" });
    channels.deliver("net.ws.error", { socket: socket.id, message: "hiccup" });
    channels.deliver("net.ws.close", { socket: socket.id, code: 1000, reason: "done" });
    const got = [];
    socket.onMessage((d) => got.push(["message", d]));
    socket.onError((m) => got.push(["error", m]));
    socket.onClose((c, r) => got.push(["close", c, r]));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(got, [["message", "early"], ["error", "hiccup"], ["close", 1000, "done"]]);
  });

  test("held socket messages always come out before newer ones", async () => {
    const { rpc } = fakeRpc({ "net.ws.connect": () => ({ open: true }) });
    const channels = createChannels(rpc, () => {});
    const socket = await channels.connect("wss://a.com/");
    channels.deliver("net.ws.message", { socket: socket.id, data: "first" });
    const got = [];
    socket.onMessage((d) => got.push(d));
    channels.deliver("net.ws.message", { socket: socket.id, data: "second" });
    channels.deliver("net.ws.close", { socket: socket.id, code: 1000, reason: "" });
    socket.onClose(() => got.push("closed"));
    channels.deliver("net.ws.message", { socket: socket.id, data: "third" });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(got, ["first", "second", "closed"]);
  });

  test("a handshake error forgets the connect waiter, the socket and the abort listener", async () => {
    let added = 0;
    let removed = 0;
    const signal = { aborted: false, addEventListener: () => added++, removeEventListener: () => removed++ };
    const { rpc, forgotten } = fakeRpc({ "net.ws.connect": () => new Promise(() => {}) });
    const channels = createChannels(rpc, () => {});
    const pending = channels.connect("wss://a.com/", { signal });
    await Promise.resolve();
    channels.deliver("net.ws.error", { socket: "w1", message: "tls failed" });
    await assert.rejects(pending, /tls failed/);
    assert.deepEqual(forgotten, [1]);
    assert.equal(channels.openCount(), 0);
    assert.equal([added, removed].join(), "1,1");
  });

  test("one queue keeps every held socket event in order, and attaching drains it at once", async () => {
    const { rpc } = fakeRpc({ "net.ws.connect": () => ({ open: true }) });
    const channels = createChannels(rpc, () => {});
    const socket = await channels.connect("wss://a.com/");
    const got = [];
    channels.deliver("net.ws.error", { socket: socket.id, message: "e1" });
    channels.deliver("net.ws.message", { socket: socket.id, data: "m1" });
    socket.onError((m) => got.push(m));
    assert.deepEqual(got, ["e1"], "attaching drains synchronously");
    socket.onMessage((d) => got.push(d));
    assert.deepEqual(got, ["e1", "m1"]);
    const late = await channels.connect("wss://b.com/");
    const order = [];
    channels.deliver("net.ws.error", { socket: late.id, message: "boom" });
    late.onMessage((d) => order.push(d));
    channels.deliver("net.ws.message", { socket: late.id, data: "after" });
    await Promise.resolve();
    late.onError((m) => order.push(m));
    assert.deepEqual(order, ["after"], "a message delivered after a turn with no error listener drops that error rather than reordering it");
    const flood = await channels.connect("wss://c.com/");
    for (let i = 0; i < 300; i++) channels.deliver("net.ws.message", { socket: flood.id, data: `m${i}` });
    channels.deliver("net.ws.close", { socket: flood.id, code: 1000, reason: "" });
    const seen = [];
    flood.onClose(() => seen.push("closed"));
    flood.onMessage((d) => seen.push(d));
    assert.equal(seen.at(0), "m0");
    assert.equal(seen.at(-1), "closed");
    assert.equal(seen.length, 257);
  });

  test("the request id is known before the transport sends, so a synchronous error forgets the right waiter", async () => {
    const { createRpc } = await import("./rpc.ts");
    let channels;
    const transport = {
      send(line) {
        const message = JSON.parse(line);
        if (message.method === "net.fetch.stream") channels.deliver("net.fetch.error", { stream: message.params.stream, message: "refused at once" });
        if (message.method === "net.ws.connect") channels.deliver("net.ws.error", { socket: message.params.socket, message: "handshake refused" });
      },
      onLine() {},
    };
    const rpc = createRpc(transport);
    channels = createChannels(rpc, () => {});
    await assert.rejects(channels.fetchStream("https://a.com/"), /refused at once/);
    await assert.rejects(channels.connect("wss://a.com/"), /handshake refused/);
    assert.equal(rpc.pendingCount(), 0);
    assert.equal(channels.openCount(), 0);
  });

  test("a refused close leaves the socket open", async () => {
    const { rpc } = fakeRpc({ "net.ws.connect": () => ({ open: true }), "net.ws.close": () => Promise.reject(new Error("busy")) });
    const channels = createChannels(rpc, () => {});
    const socket = await channels.connect("wss://a.com/");
    await assert.rejects(socket.close(), /busy/);
    assert.equal(socket.state, "open");
  });

  test("attaching onClose before onMessage still delivers a buffered message before close", async () => {
    const { rpc } = fakeRpc({ "net.ws.connect": () => ({ open: true }) });
    const channels = createChannels(rpc, () => {});
    const socket = await channels.connect("wss://a.com/");
    channels.deliver("net.ws.message", { socket: socket.id, data: "hello" });
    channels.deliver("net.ws.close", { socket: socket.id, code: 1000, reason: "bye" });
    const seen = [];
    socket.onClose((code, reason) => seen.push(`close:${code}:${reason}`));
    socket.onMessage((data) => seen.push(`msg:${data}`));
    await Promise.resolve();
    assert.deepEqual(seen, ["msg:hello", "close:1000:bye"]);
    const full = await channels.connect("wss://full.com/");
    const events = [];
    full.onError((m) => events.push(`error:${m}`));
    for (let i = 0; i < 256; i++) channels.deliver("net.ws.message", { socket: full.id, data: String(i) });
    channels.deliver("net.ws.error", { socket: full.id, message: "boom" });
    channels.deliver("net.ws.close", { socket: full.id, code: 1000, reason: "" });
    full.onClose(() => events.push("close"));
    full.onMessage((d) => events.push(`msg:${d}`));
    await Promise.resolve();
    assert.equal(events.length, 258);
    assert.deepEqual(events.slice(-3), ["msg:255", "error:boom", "close"]);
  });

  test("a failed activation closes the channels it opened", async () => {
    const errors = [];
    const host = createMockHost({ runtime: { onError: (e) => errors.push(e) } });
    host.mockFetchStream("https://a.com/", { chunks: ["x", "y", "z"] });
    await host.load({
      activate: async (ardia) => {
        await ardia.net.fetchStream("https://a.com/");
        throw new Error("activation broke");
      },
    }).catch(() => {});
    await host.settle();
    assert.equal(host.runtime.channelCount(), 0);
    assert.ok(host.requests("net.fetch.cancel").length >= 1);
    assert.ok(errors.some((e) => /activation broke/.test(e.message)));
    await host.dispose();
  });
});

describe("services, sidecar and content scripts", () => {
  test("a plugin provides a service, the host calls it, and it calls another", async () => {
    const host = createMockHost();
    host.respond("services.call", (params) => ({ echoed: params }));
    host.respond("services.list", () => ({ providers: [{ plugin: "@a/ai", version: "1.0.0", methods: ["complete"] }] }));
    await host.load({ services: { "ai.provider": { complete: (input) => ({ text: `hi ${input.prompt}` }) } } });
    assert.deepEqual(host.requests("ready")[0].services, { "ai.provider": ["complete"] });
    assert.deepEqual(await host.callService("ai.provider", "complete", { prompt: "there" }), { text: "hi there" });
    await assert.rejects(host.callService("ai.provider", "nope"), /no method nope/);
    await assert.rejects(host.callService("search.provider", "find"), /doesn't provide search.provider/);
    const reply = await host.ardia.services.call("credentials.provider", "get", { site: "a.com" }, { provider: "@a/pw" });
    assert.deepEqual(reply.echoed, { iface: "credentials.provider", method: "get", input: { site: "a.com" }, provider: "@a/pw" });
    assert.equal((await host.ardia.services.list("ai.provider"))[0].plugin, "@a/ai");
    const later = host.ardia.services.provide("search.provider", { find: () => [] });
    await host.settle();
    assert.deepEqual(host.requests("services.provide")[0], { iface: "search.provider", methods: ["find"] });
    later.dispose();
    await host.settle();
    assert.deepEqual(host.requests("services.withdraw")[0], { iface: "search.provider" });
    assert.throws(() => host.ardia.services.provide("bad", {}), /isn't an interface name/);
    await host.dispose();
  });

  test("sidecar messages and content-script messages reach their listeners, even during activate", async () => {
    const host = createMockHost();
    const fromSidecar = [];
    const fromContent = [];
    host.respond("sidecar.request", (params) => ({ answered: params.method }));
    await host.load({
      activate: (ardia) => {
        ardia.sidecar.onMessage((m) => fromSidecar.push(m));
        ardia.page.onContentMessage((e) => fromContent.push(e));
      },
    });
    await host.sendSidecarMessage({ hello: 1 });
    await host.sendContentMessage("t1", { clicked: true }, { scriptId: "c" });
    assert.deepEqual(fromSidecar, [{ hello: 1 }]);
    assert.deepEqual(fromContent, [{ tabId: "t1", scriptId: "c", message: { clicked: true } }]);
    assert.deepEqual(await host.ardia.sidecar.request("index", { path: "/" }), { answered: "index" });
    await host.ardia.page.sendToContent("t1", { go: true });
    assert.deepEqual(host.requests("page.sendToContent")[0], { tabId: "t1", message: { go: true } });
    await host.dispose();
  });

  test("a stream opened inside activate isn't held behind activation", async () => {
    const host = createMockHost();
    host.mockFetchStream("https://a.com/", { chunks: ["x", "y"] });
    let body = "";
    await host.load({
      activate: async (ardia) => {
        body = await (await ardia.net.fetchStream("https://a.com/")).text();
      },
    });
    assert.equal(body, "xy");
    await host.dispose();
  });

  test("the rest of the v3 surface speaks the documented host methods", async () => {
    const host = createMockHost({ strict: false });
    host.respond("page.readActive", (params) => ({ tabId: "t", url: "https://a.com", title: "A", text: "x", ...(params.markdown ? { markdown: "# A" } : {}) }));
    host.respond("clipboard.readText", () => ({ text: "copied" }));
    host.respond("auth.signIn", (params) => ({ accessToken: "tok", tokenType: "bearer", pkce: params.pkce }));
    await host.load({});
    const a = host.ardia;
    assert.equal((await a.page.readActive({ markdown: true })).markdown, "# A");
    assert.equal(await a.clipboard.readText(), "copied");
    assert.deepEqual(await a.auth.signIn({ authorizeUrl: "https://id.example.com/authorize", tokenUrl: "https://id.example.com/token", clientId: "c", scopes: ["read"] }), { accessToken: "tok", tokenType: "bearer", pkce: "S256" });
    assert.throws(() => a.auth.signIn({ authorizeUrl: "http://id.example.com/", tokenUrl: "https://x", clientId: "c" }), /https/);
    await a.bookmarks.search("news");
    await a.history.recent(5);
    await a.profiles.list();
    await a.media.control("t", "pause");
    await a.splits.open({ urls: ["https://a.com"] });
    await a.peek.open("https://b.com");
    await a.fs.pickFiles({ multiple: true });
    await a.fs.saveFile({ name: "a.txt", data: "hi" });
    await a.ui.notify({ title: "Done" });
    const methods = host.sent.map((r) => r.method);
    for (const method of ["bookmarks.search", "history.recent", "profiles.list", "media.control", "splits.open", "peek.open", "fs.pickFiles", "fs.saveFile", "ui.notify"]) assert.ok(methods.includes(method), method);
    assert.deepEqual(host.requests("fs.saveFile")[0], { encoding: "utf8", name: "a.txt", data: "hi" });
    await host.dispose();
  });

  test("the mock host runs commands, tools, decide hooks and omnibox, with storage", async () => {
    const host = createMockHost();
    await host.load({
      commands: { save: async (input, call) => (await host.ardia.storage.set("k", input), call.name) },
      tools: { add: ({ a, b }) => a + b, fail: () => { throw new Error("nope"); } },
      decide: { "tab.opening": (data) => ({ allow: data.url !== "https://bad.com" }) },
      omnibox: (query) => [{ title: `Find ${query}`, url: `https://s.com/?q=${query}` }],
    });
    assert.equal(await host.runCommand("save", 42), "save");
    assert.equal(host.storage.get("k"), 42);
    assert.equal(await host.callTool("add", { a: 2, b: 3 }), 5);
    await assert.rejects(host.callTool("fail"), /nope/);
    assert.deepEqual(await host.decide("tab.opening", { url: "https://bad.com" }), { allow: false });
    assert.deepEqual(await host.omnibox("cats"), [{ title: "Find cats", url: "https://s.com/?q=cats" }]);
    await host.dispose();
  });
});

describe("readServerSentEvents", () => {
  test("follows the event-stream rules for fields, comments, CRLF and ids", async () => {
    async function* chunks() {
      yield "\uFEFF: comment\r\nid: 7\r\nretry: 1500\r\ndata: a\r";
      yield "\ndata: b\r\n\r\nevent: x\ndata\n\n";
      yield "data: tail";
    }
    const events = [];
    for await (const e of readServerSentEvents(chunks())) events.push(e);
    assert.deepEqual(events, [
      { event: "message", data: "a\nb", id: "7", retry: 1500 },
      { event: "x", data: "", id: "7" },
      { event: "message", data: "tail", id: "7" },
    ]);
  });
});
