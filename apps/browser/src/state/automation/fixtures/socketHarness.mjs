import assert from "node:assert/strict";
const { useBrowser } = await import("../../browser/store.ts");
const { startAutomation } = await import("../controlSocket.ts");
const { registerPluginSocketMethods } = await import("../../plugins/start.ts");
const stub = await import("../../../test-native/index.ts");

export const S = () => useBrowser.getState();
export const tick = () => new Promise((resolve) => setImmediate(resolve));

export function socketClient(connection) {
  let nextId = 0;
  const fire = (method, params, raw) => {
    const id = ++nextId;
    const before = stub.controlSocket.replies.length;
    const line = raw ?? JSON.stringify({ id, method, ...(params ? { params } : {}) });
    stub.emitControlRequest({ connection, generation: stub.controlSocket.generation, line });
    return (async () => {
      const answered = () => stub.controlSocket.replies.slice(before).some((r) => r.connection === connection);
      const deadline = Date.now() + 2000;
      for (let i = 0; !answered() && (i < 200 || Date.now() < deadline); i++) await (i < 200 ? tick() : new Promise((resolve) => setTimeout(resolve, 1)));
      const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === connection);
      assert.equal(replies.length, 1, `one reply to ${method}`);
      return JSON.parse(replies[0].line);
    })();
  };
  const call = (method, params) => fire(method, params);
  const ok = async (method, params) => {
    const reply = await call(method, params);
    assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
    return reply.result;
  };
  return { fire, call, ok };
}

export async function controlOn() {
  S().updateSettings({ cliControl: true });
  startAutomation();
  registerPluginSocketMethods();
  for (let i = 0; i < 20 && !stub.controlSocket.running; i++) await tick();
  await tick();
}

export async function freshWindow(url = "https://a.example/") {
  S().hydrate({});
  await controlOn();
  const windowId = S().createWindow({ url });
  return { windowId, tab: S().windows[windowId].activeTabIds[S().windows[windowId].profileId] };
}
