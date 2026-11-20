import assert from "node:assert/strict";
import test from "node:test";
import { createConnectSession, type ConnectApi, type FolderPick } from "./connectSession.ts";

const GOOD = "good phrase";
const valid = (phrase: string) => phrase.startsWith("good") || phrase.startsWith("wrong");

function fakeApi(picks: (FolderPick | null)[]) {
  const calls: string[] = [];
  const forgotten: string[] = [];
  const api: ConnectApi = {
    pickFolder: async () => {
      calls.push("pick");
      return picks.shift() ?? null;
    },
    connect: async (phrase, folder) => {
      calls.push(`connect ${folder.folder}`);
      return phrase === GOOD ? { result: "connected" } : { result: "invalidPhrase" };
    },
    forgetFolder: async (folder) => {
      forgotten.push(folder.folder);
    },
  };
  return { api, calls, forgotten };
}

const A = { folder: "content://a", name: "Ardia Sync" };
const B = { folder: "content://b", name: "Other" };

test("a wrong phrase keeps the picked folder, so fixing the words connects without asking for the folder again", async () => {
  const { api, calls, forgotten } = fakeApi([A]);
  const session = createConnectSession(api, valid);
  assert.deepEqual(await session.pickFolder("wrong phrase"), { result: "invalidPhrase" });
  assert.deepEqual(session.state().folder, A);
  assert.deepEqual(session.state().failure, { result: "invalidPhrase" });
  assert.deepEqual(await session.connectIfReady(GOOD), { result: "connected" });
  assert.deepEqual(calls, ["pick", "connect content://a", "connect content://a"]);
  assert.equal(session.state().folder, null);
  session.abandon();
  assert.deepEqual(forgotten, []);
});

test("a folder picked before the phrase waits, and connects once the phrase is valid", async () => {
  const { api, calls } = fakeApi([A]);
  const session = createConnectSession(api, valid);
  assert.equal(await session.pickFolder(""), null);
  assert.equal(await session.connectIfReady("not yet"), null);
  assert.deepEqual(await session.connectIfReady(GOOD), { result: "connected" });
  assert.deepEqual(calls, ["pick", "connect content://a"]);
});

test("leaving with a picked folder forgets it, and picking another forgets the one before", async () => {
  const { api, forgotten } = fakeApi([A, B]);
  const session = createConnectSession(api, valid);
  await session.pickFolder("");
  await session.pickFolder("");
  assert.deepEqual(forgotten, ["content://a"]);
  session.abandon();
  assert.deepEqual(forgotten, ["content://a", "content://b"]);
  assert.equal(session.state().folder, null);
});

test("cancelling the picker keeps the folder already picked", async () => {
  const { api, forgotten } = fakeApi([A, null]);
  const session = createConnectSession(api, valid);
  await session.pickFolder("");
  await session.pickFolder("");
  assert.deepEqual(session.state().folder, A);
  assert.deepEqual(forgotten, []);
});

test("a connect that throws reads as an unavailable folder and keeps the folder for another try", async () => {
  const { api } = fakeApi([A]);
  const session = createConnectSession({ ...api, connect: async () => Promise.reject(new Error("io")) }, valid);
  await session.pickFolder(GOOD);
  assert.deepEqual(session.state().failure, { result: "folderUnavailable" });
  assert.deepEqual(session.state().folder, A);
  assert.equal(session.state().connecting, false);
});
