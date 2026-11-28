package com.ardia.browser

import java.io.File
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class PageBlobsScriptTest {
    companion object {
        private lateinit var seen: JSONObject

        private val driver = """
const vm = require("vm");
const fs = require("fs");
const posted = [];
const bridgeListeners = [];
const windowListeners = {};
const dispatched = [];
const timers = new Map();
let timerIds = 0;
let clock = 1000;
let made = 0;
class EventTarget { dispatchEvent(event) { dispatched.push(event); return true; } }
class HTMLAnchorElement extends EventTarget {
  constructor(href, name) { super(); this.href = href; this.name = name; }
  getAttribute(attribute) { return attribute === "download" ? this.name : null; }
  click() { dispatched.push("clicked"); }
}
class Event { constructor(type) { this.initial = type; } get type() { return this.initial; } }
class MouseEvent extends Event {}
class Blob {
  constructor(size, type) { this.size = size; this.type = type || ""; }
  slice(from, to) { return new Blob(Math.max(0, Math.min(to, this.size) - from), this.type); }
}
class File extends Blob { constructor(size, type, name) { super(size, type); this.name = name; } }
class FileReader { readAsDataURL(blob) { this.result = "data:;base64," + "A".repeat(Math.ceil(blob.size / 3) * 4); queueMicrotask(() => this.onload()); } }
const context = {
  ardiaPage: { postMessage: (text) => posted.push(text), addEventListener: (type, listener) => bridgeListeners.push(listener) },
  URL: { createObjectURL: () => "blob:https://a.example/" + (++made), revokeObjectURL: () => {} },
  Blob, File, FileReader, EventTarget, HTMLAnchorElement, Event, MouseEvent,
  fetch: async () => { throw new Error("revoked"); },
  setTimeout: (run, delay) => { timers.set(++timerIds, { run, at: clock + delay }); return timerIds; },
  clearTimeout: (id) => { timers.delete(id); },
  Date: { now: () => clock },
  addEventListener: (type, listener) => { windowListeners[type] = listener; },
  queueMicrotask,
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(process.argv[2], "utf8"), context);
const tell = (text) => bridgeListeners.forEach((listener) => listener({ data: "ardiaBlob:" + text }));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const advance = (millis) => { clock += millis; for (const [id, timer] of [...timers]) { if (timer.at <= clock) { timers.delete(id); timer.run(); } } };
const said = (start) => posted.filter((text) => text.startsWith("ardiaBlob:" + start));
(async () => {
  const seen = {};
  seen.helloAtStart = said("hello").length;
  const thrower = new context.MouseEvent("click");
  Object.defineProperty(thrower, "type", { get() { throw new Error("page getter"); } });
  let threw = false;
  try { new HTMLAnchorElement("blob:https://a.example/x", "x.txt").dispatchEvent(thrower); } catch (error) { threw = true; }
  seen.throwingTypeThrew = threw;
  seen.throwingTypeDispatched = dispatched.includes(thrower);
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("proxy"); } });
  threw = false;
  try { context.EventTarget.prototype.dispatchEvent.call(hostile, new context.MouseEvent("click")); } catch (error) { threw = true; }
  seen.hostileThisThrew = threw;
  const saver = new HTMLAnchorElement("blob:https://a.example/saved", "story.txt");
  saver.dispatchEvent(new context.MouseEvent("click"));
  seen.fileSaverNamed = said("name blob%3Ahttps%3A%2F%2Fa.example%2Fsaved story.txt").length;
  const urls = [];
  for (let index = 0; index < 20; index++) urls.push(context.URL.createObjectURL(new Blob(8 * 1024 * 1024, "image/jpeg")));
  for (const url of urls) context.URL.revokeObjectURL(url);
  tell("fetch aaaa " + urls[0]);
  tell("fetch bbbb " + urls[19]);
  await settle();
  seen.oldestRevokedMissing = said("missing aaaa").length;
  seen.newestRevokedKept = said("start bbbb").length;
  const big = context.URL.createObjectURL(new Blob(200 * 1024 * 1024, "video/mp4"));
  context.URL.revokeObjectURL(big);
  tell("fetch cccc " + big);
  tell("fetch ffff " + urls[19]);
  await settle();
  seen.biggestLatestKept = said("start cccc").length;
  seen.olderDroppedForTheBiggest = said("missing ffff").length;
  const live = context.URL.createObjectURL(new File(10, "text/plain", "notes.txt"));
  tell("fetch dddd " + live);
  await settle();
  seen.fileNamed = said("start dddd 10 text%2Fplain notes.txt").length;
  tell("cancel dddd");
  tell("next dddd 0");
  await settle();
  seen.cancelledFails = said("fail dddd").length;
  tell("fetch eeee " + live);
  await settle();
  tell("next eeee 0");
  await settle();
  seen.chunkBeforeIdle = said("chunk eeee 0").length;
  advance(61000);
  advance(61000);
  tell("next eeee 1");
  await settle();
  seen.idleExpiredFails = said("fail eeee").length;
  windowListeners.pagehide();
  seen.byeOnHide = said("bye").length;
  const party = "\u{1F389}".repeat(257) + ".txt";
  new HTMLAnchorElement("blob:https://a.example/party", party).dispatchEvent(new context.MouseEvent("click"));
  const partyField = (said("name blob%3Ahttps%3A%2F%2Fa.example%2Fparty ")[0] || "").split(" ")[2] || "";
  seen.fittedNameLength = partyField.length;
  seen.fittedNameKeepsExtension = decodeURIComponent(partyField).endsWith(".txt");
  seen.fittedNameWholeEmoji = [...decodeURIComponent(partyField).slice(0, -4)].every((point) => point === "\u{1F389}");
  const longFile = context.URL.createObjectURL(new File(3, "text/plain", "x".repeat(5000) + ".csv"));
  tell("fetch gggg " + longFile);
  await settle();
  const longField = decodeURIComponent((said("start gggg ")[0] || "").split(" ")[4] || "");
  seen.fittedFileNameLength = longField.length;
  seen.fittedFileNameKeepsExtension = longField.endsWith(".csv");
  const profiled = context.URL.createObjectURL(new Blob(2, 'Text/Plain ; profile="' + "p".repeat(560) + '"'));
  tell("fetch hhhh " + profiled);
  await settle();
  seen.typeSent = ((said("start hhhh ")[0] || "").split(" ")[3]) || "";
  const refs = (() => {
    const made = [];
    const urls = [];
    for (let index = 0; index < 20; index++) {
      const blob = new Blob(8 * 1024 * 1024, "image/png");
      made.push(new WeakRef(blob));
      urls.push(context.URL.createObjectURL(blob));
    }
    for (const url of urls) context.URL.revokeObjectURL(url);
    return made;
  })();
  await settle();
  global.gc();
  await settle();
  global.gc();
  seen.evictedStillAlive = refs.slice(0, 12).filter((ref) => ref.deref() !== undefined).length;
  seen.keptAlive = refs.slice(12).filter((ref) => ref.deref() !== undefined).length;
  windowListeners.pageshow({ persisted: true });
  seen.helloAfterRestore = said("hello").length;
  console.log(JSON.stringify(seen));
})();
""".trimIndent()

        @BeforeClass
        @JvmStatic
        fun runScript() {
            val folder = kotlin.io.path.createTempDirectory("page-blobs-script").toFile()
            try {
                val script = File(folder, "script.js").apply { writeText(PageBlobs.script) }
                val drive = File(folder, "drive.js").apply { writeText(driver) }
                val process = ProcessBuilder("node", "--expose-gc", drive.absolutePath, script.absolutePath).redirectErrorStream(true).start()
                val output = process.inputStream.bufferedReader().readText()
                assertTrue("node finished", process.waitFor(30, TimeUnit.SECONDS))
                assertEquals(output, 0, process.exitValue())
                seen = JSONObject(output.trim().lines().last())
            } finally {
                folder.deleteRecursively()
            }
        }
    }

    @Test
    fun aPageEventWhoseTypeThrowsStillDispatchesUntouched() {
        assertFalse(seen.getBoolean("throwingTypeThrew"))
        assertTrue(seen.getBoolean("throwingTypeDispatched"))
        assertFalse(seen.getBoolean("hostileThisThrew"))
    }

    @Test
    fun aDetachedLinkClickedByDispatchStillReportsItsName() {
        assertEquals(1, seen.getInt("fileSaverNamed"))
    }

    @Test
    fun revokedBlobsAreKeptOnlyUpToTheByteAndCountCapsButTheLatestAlways() {
        assertEquals(1, seen.getInt("oldestRevokedMissing"))
        assertEquals(1, seen.getInt("newestRevokedKept"))
        assertEquals(1, seen.getInt("biggestLatestKept"))
        assertEquals(1, seen.getInt("olderDroppedForTheBiggest"))
    }

    @Test
    fun aFileKeepsItsNameAndACancelledOrIdleSendIsDropped() {
        assertEquals(1, seen.getInt("fileNamed"))
        assertEquals(1, seen.getInt("cancelledFails"))
        assertEquals(1, seen.getInt("chunkBeforeIdle"))
        assertEquals(1, seen.getInt("idleExpiredFails"))
    }

    @Test
    fun evictedRevokedBlobsCanBeCollectedBeforeTheirTimersRun() {
        assertEquals(0, seen.getInt("evictedStillAlive"))
        assertEquals(8, seen.getInt("keptAlive"))
    }

    @Test
    fun onlyTheTypeAndSubtypeAreSent() {
        assertEquals("Text%2FPlain", seen.getString("typeSent"))
    }

    @Test
    fun aLeavingPageSaysBye() {
        assertEquals(1, seen.getInt("byeOnHide"))
    }

    @Test
    fun longNamesAreFittedByWholeCharactersAndKeepTheirExtension() {
        val fitted = seen.getInt("fittedNameLength")
        assertTrue("$fitted", fitted in 3_000..PageMadeDownloads.MAX_NAME_FIELD_CHARS)
        assertTrue(seen.getBoolean("fittedNameKeepsExtension"))
        assertTrue(seen.getBoolean("fittedNameWholeEmoji"))
        assertEquals(PageMadeDownloads.MAX_NAME_CHARS, seen.getInt("fittedFileNameLength"))
        assertTrue(seen.getBoolean("fittedFileNameKeepsExtension"))
    }

    @Test
    fun aPageRestoredFromTheBackForwardCacheSaysHelloAgain() {
        assertEquals(1, seen.getInt("helloAtStart"))
        assertEquals(2, seen.getInt("helloAfterRestore"))
    }
}
