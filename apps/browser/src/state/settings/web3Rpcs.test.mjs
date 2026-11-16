import assert from "node:assert/strict";
import { test } from "node:test";
import { web3RpcProblem } from "./web3Rpcs.ts";

test("an RPC is accepted only where the engine uses it: https anywhere, http on this machine, a port that exists", () => {
  for (const url of ["https://ethereum-rpc.publicnode.com", "https://rpc.example:65535/v2/key", "https://[2001:db8::1]:8545", "http://127.0.0.1:8545", "http://localhost", "http://[::1]:8545/"])
    assert.equal(web3RpcProblem("1", url), null, url);
  for (const url of ["https://rpc.example:99999", "http://127.0.0.1:65536", "http://rpc.example", "http://192.168.1.2:8545", "https://user@rpc.example", "https://rpc.example/#frag", "ftp://rpc.example"])
    assert.notEqual(web3RpcProblem("1", url), null, url);
});

test("a chain ID is a whole number above 0", () => {
  assert.equal(web3RpcProblem("10", "https://rpc.example"), null);
  for (const chain of ["0", "01", "-1", "1.5", "eth", ""]) assert.notEqual(web3RpcProblem(chain, "https://rpc.example"), null, chain);
});

test("Add RPC keeps only a URL the engine accepts, and puts the engine's map back when it refuses", async () => {
  const { web3RpcsRefused, web3RpcsSent } = await import("../../test-native/index.ts");
  const { useBrowser } = await import("../browser/store.ts");
  const { addWeb3Rpc } = await import("./actions.ts");
  useBrowser.getState().updateSettings({ web3Rpcs: { 1: "https://ethereum-rpc.publicnode.com" } });
  web3RpcsRefused.add("https://[::::]");
  web3RpcsSent.length = 0;

  assert.notEqual(await addWeb3Rpc("10", "https://[::::]"), null);
  assert.deepEqual(useBrowser.getState().settings.web3Rpcs, { 1: "https://ethereum-rpc.publicnode.com" });
  assert.deepEqual(web3RpcsSent.at(-1), { 1: "https://ethereum-rpc.publicnode.com" });

  const refusal = addWeb3Rpc("10", "https://[::::]");
  useBrowser.getState().updateSettings({ web3Rpcs: {} });
  assert.notEqual(await refusal, null);
  assert.deepEqual(web3RpcsSent.at(-1), {}, "a refusal restores the map as it is now, not as it was before the check");
  useBrowser.getState().updateSettings({ web3Rpcs: { 1: "https://ethereum-rpc.publicnode.com" } });

  assert.equal(await addWeb3Rpc("10", "https://optimism-rpc.publicnode.com"), null);
  assert.deepEqual(useBrowser.getState().settings.web3Rpcs, { 1: "https://ethereum-rpc.publicnode.com", 10: "https://optimism-rpc.publicnode.com" });
});
