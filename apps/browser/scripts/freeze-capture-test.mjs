import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, sleep } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appArg = args.find((a) => !a.startsWith("--"));
if (!appArg || args.includes("--help")) {
  console.error("usage: node freeze-capture-test.mjs <Debug Ardia.app> [--metro=<port>] [--keep]\n" +
    "  Freezes each thread on purpose in a hidden instance (ARDIA_TEST freezeWatchActive acts the app active) and checks the\n" +
    "  stack samples, the app_freeze event, the local freezes.txt record written 2 s into a freeze, that it survives a kill -9\n" +
    "  in the middle of one, that sharing off sends nothing, and Copy Last Freeze's text.");
  process.exit(2);
}
const metroPort = Number(args.find((a) => a.startsWith("--metro="))?.slice(8) ?? 8081);
const keep = args.includes("--keep");
const scratch = mkdtempSync(join(tmpdir(), "ac-freeze-capture-"));
const data = join(scratch, "data");
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const SLOT = 4096;
const slots = () => {
  const file = join(data, "freezes.txt");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "latin1");
  const out = [];
  for (let at = 0; at < text.length; at += SLOT) {
    const slot = text.slice(at, at + SLOT);
    const head = /^freeze (\d+) (main|js) (frozen|recovered)$/m.exec(slot.split("\n")[0] ?? "");
    if (head) out.push({ seq: +head[1], thread: head[2], state: head[3], text: slot.slice(0, slot.indexOf("\nend\n") + 4) });
  }
  return out.sort((a, b) => a.seq - b.seq);
};
const sentNow = async (inst) => {
  await inst.eval("return acTelemetry.flush().then(() => true)", { timeout: 30000 });
  const file = join(data, "telemetry-requests.log");
  return existsSync(file) ? readFileSync(file, "utf8").split('{"key":"event","value":{"stringValue":"app_freeze"}}').length - 1 : 0;
};
const launchIt = () => launch(appArg, { data, onboarded: true, metroPort, test: { freezeWatchActive: "1" } });
const settle = async (inst, ms) => {
  await sleep(ms + 400);
  for (const end = Date.now() + 20000; Date.now() < end; await sleep(200)) if (await inst.eval("return true", { timeout: 5000 }).catch(() => false)) return;
};

let inst = await launchIt();
try {
  await inst.eval("acTelemetry.setSharing(true, 'settings'); return true");
  await sleep(1500);

  const atStart = await sentNow(inst);
  await inst.eval("return expo.modules.ArdiaDev.devBlockMain(1200)");
  await settle(inst, 1200);
  await sleep(1000);
  let main = slots().filter((s) => s.thread === "main").at(-1);
  const mainFrames = main ? [...main.text.matchAll(/^ {2}(\S[^+]*) \+0x/gm)].map((m) => m[1].trim()) : [];
  check("a 1.2 s main-thread block is sampled and recorded", !!main && main.state === "recovered" && /sample 1 /.test(main.text) && mainFrames.some((f) => /^Ardia/.test(f)),
    main ? `${mainFrames.length} frames, images ${[...new Set(mainFrames)].join(", ")}` : "no record");
  check("the record carries no paths or symbol names", !!main && !main.text.includes("/") && !/[a-z]+::|_Z[A-Z]/.test(main.text));

  await inst.eval("return ac.blockJs(1200, true)");
  await settle(inst, 1200);
  await sleep(1000);
  const js = slots().filter((s) => s.thread === "js").at(-1);
  check("a 1.2 s garbage-heavy JS block is sampled with Hermes frames and its GC time", !!js && /hermes \+0x/.test(js.text) && /gc_ms \d+/.test(js.text), js ? js.text.split("\n").slice(0, 6).join(" | ") : "no record");
  const both = await sentNow(inst);
  check("app_freeze was sent for both (sharing on)", both - atStart === 2, `${both - atStart} sent for the two blocks (${atStart} before them, from launch)`);

  await inst.eval("acTelemetry.setSharing(false, 'settings'); return true");
  const before = await sentNow(inst);
  await inst.eval("return expo.modules.ArdiaDev.devBlockMain(900)");
  await settle(inst, 900);
  await sleep(1500);
  const afterOff = await sentNow(inst);
  check("sharing off: recorded locally, nothing sent", slots().at(-1)?.thread === "main" && afterOff === before, `${afterOff - before} sent`);

  const lines = await inst.eval("const r = ac.freezes.localFreezes(); return [ac.freezes.freezeSummaryLine(r), ac.freezes.lastFreezeText(r).split('\\n')[1]]");
  check("Copy Diagnostics' line and Copy Last Freeze's text", /^Freezes: \d+ today/.test(lines[0]) && /^freeze \d+ main recovered$/.test(lines[1]), lines.join(" || "));

  void inst.eval("return expo.modules.ArdiaDev.devBlockMain(6000)").catch(() => {});
  await sleep(3000);
  const during = slots().at(-1);
  check("2 s into a 6 s freeze the record is already on disk, marked frozen", !!during && during.state === "frozen" && during.thread === "main", during?.text.split("\n")[0]);
  await settle(inst, 3000);
  await sleep(1000);
  check("after recovery the same slot says recovered with its length", slots().find((s) => s.seq === during?.seq)?.state === "recovered" && /duration_ms 6\d{3}/.test(slots().find((s) => s.seq === during?.seq)?.text ?? ""));

  void inst.eval("return expo.modules.ArdiaDev.devBlockMain(8000)").catch(() => {});
  await sleep(3500);
  process.kill(inst.pid, "SIGKILL");
  await sleep(1500);
  const killed = slots().at(-1);
  check("a kill -9 in the middle of a freeze leaves a readable record", !!killed && killed.state === "frozen" && /sample 1 /.test(killed.text) && killed.text.endsWith("\nend"), killed?.text.split("\n").slice(0, 3).join(" | "));
  inst = await launchIt();
  const after = await inst.eval(`return ac.freezes.localFreezes().find((r) => r.seq === ${killed?.seq ?? -1})`);
  check("after relaunch the app reads the killed freeze back", after?.seq === killed?.seq && after?.recovered === false, after ? `seq ${after.seq}, recovered ${after.recovered}` : "none");
} finally {
  if (!keep) await inst.quit().catch(() => {});
  if (!keep) rmSync(scratch, { recursive: true, force: true });
  else console.log(`kept ${scratch}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
