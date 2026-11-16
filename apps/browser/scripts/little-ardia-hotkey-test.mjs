import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { launch, session, sleep } from "../../../scripts/lib/instance.mjs";

const appArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!appArg) {
  console.error("usage: node little-ardia-hotkey-test.mjs <Debug Ardia.app>");
  console.error("Presses Little Ardia's shortcut for other apps in a hidden instance (through the shell's own handler, since a background instance never registers the system-wide key) and checks the binding it would register, rebinding, the setting, and that the window opens without the app activating.");
  process.exit(2);
}

const CMD = 256, OPTION = 2048, KEY_N = 45, KEY_Y = 16;
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const inst = await launch(resolve(appArg), {
  onboarded: true,
  session: session({ windows: [{}], tabs: [{ id: "t1", url: "about:blank" }] }),
  ready: "return !!ac.store.getState().windowOrder.length",
});

const hotKey = (press = false) => inst.eval(`return ac.shell.devLittleArdiaHotKey(${press})`);
const littleWindows = () => inst.eval(`const s = ac.store.getState(); return s.windowOrder.filter((id) => s.windows[id]?.kind === "small").length`);
const settled = async (test, ms = 4000) => {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if ((last = await test())) return last;
  return last;
};

try {
  const initial = await settled(async () => ((await hotKey()).enabled ? hotKey() : null));
  check("the setting is on by default and reaches the shell", initial?.enabled === true, JSON.stringify(initial));
  check("the binding is ⌥⌘N", initial?.keyCode === KEY_N && initial?.modifiers === (CMD | OPTION), JSON.stringify(initial));
  check("a background instance never registers the system-wide key", initial?.listens === false && initial?.registered === false);

  const before = await littleWindows();
  const pressed = await hotKey(true);
  const opened = await settled(async () => ((await littleWindows()) > before ? littleWindows() : 0));
  check("pressing it opens a Little Ardia window", opened === before + 1, `${before} → ${opened}`);
  check("still not registered after a press", pressed.registered === false);
  await sleep(500);
  const log = readFileSync(inst.log, "utf8");
  check("the app didn't activate (background mode logs it instead)", log.includes("[littleArdia] opened from another app (background mode, not activated)"));

  const second = await hotKey(true);
  const two = await settled(async () => ((await littleWindows()) >= before + 2 ? littleWindows() : 0));
  check("a second press opens another one, as ⌥⌘N does", two === before + 2 && second.enabled, `${two}`);

  await inst.eval(`ac.store.getState().updateSettings({ shortcuts: { ...ac.store.getState().settings.shortcuts, newLittleArdia: ["y", "option", "command"] } }); return true`);
  const rebound = await settled(async () => ((await hotKey()).keyCode === KEY_Y ? hotKey() : null));
  check("it follows a rebinding to ⌥⌘Y", rebound?.keyCode === KEY_Y && rebound?.modifiers === (CMD | OPTION), JSON.stringify(rebound));

  await inst.eval(`ac.store.getState().updateSettings({ shortcuts: {} }); return true`);
  const reset = await settled(async () => ((await hotKey()).keyCode === KEY_N ? hotKey() : null));
  check("resetting the shortcut goes back to ⌥⌘N", reset?.keyCode === KEY_N);

  await inst.eval(`ac.store.getState().updateSettings({ littleArdiaFromOtherApps: false }); return true`);
  const off = await settled(async () => ((await hotKey()).enabled === false ? hotKey() : null));
  check("turning the setting off reaches the shell", off?.enabled === false && off?.registered === false, JSON.stringify(off));
} finally {
  await inst.quit();
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(", ")}` : "\nall passed");
process.exit(failures.length ? 1 : 0);
