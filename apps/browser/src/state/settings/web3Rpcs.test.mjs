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
