import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "ardia-launch-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
});

const { testGateRefusal } = await import("./launch.ts");

test("a data folder that is the live XDG data or config folder, or inside one, is never a test instance", () => {
  const dataHome = join(scratch, "data-home");
  const configHome = join(scratch, "config-home");
  mkdirSync(join(dataHome, "ardia"), { recursive: true });
  mkdirSync(join(configHome, "ardia"), { recursive: true });
  process.env.XDG_DATA_HOME = dataHome;
  process.env.XDG_CONFIG_HOME = configHome;
  assert.match(testGateRefusal(join(dataHome, "ardia")), /real data folder/);
  assert.match(testGateRefusal(join(dataHome, "ardia", "Profiles")), /real data folder/);
  assert.match(testGateRefusal(join(configHome, "ardia")), /real data folder/);
  assert.equal(testGateRefusal(join(scratch, "elsewhere")), "");
});

test("symlinks to the live XDG folder, or under it, are followed before deciding", () => {
  const realHome = join(scratch, "real-home");
  mkdirSync(join(realHome, "ardia"), { recursive: true });
  const linkedHome = join(scratch, "linked-home");
  symlinkSync(realHome, linkedHome);
  process.env.XDG_DATA_HOME = linkedHome;
  const pointer = join(scratch, "pointer");
  symlinkSync(join(realHome, "ardia"), pointer);
  assert.match(testGateRefusal(pointer), /real data folder/);
  assert.match(testGateRefusal(join(realHome, "ardia")), /real data folder/);
  assert.match(testGateRefusal(join(pointer, "not-made-yet", "deeper")), /real data folder/);
});

test("with no XDG variables the default home folders are still refused", () => {
  assert.match(testGateRefusal(join(process.env.HOME!, ".local/share/ardia")), /real data folder/);
  assert.match(testGateRefusal(join(process.env.HOME!, ".config/ardia")), /real data folder/);
});
