package com.ardia.browser

import java.io.IOException
import java.io.InputStream
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class PageBlobs(
    private val onMain: (Runnable) -> Unit,
    private val firstAnswerMillis: Long = FIRST_ANSWER_MILLIS,
    private val chunkIdleMillis: Long = CHUNK_IDLE_MILLIS,
    private val totalMillis: Long = TOTAL_MILLIS,
    private val now: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private class Frame(val origin: String, val isMain: Boolean, val send: (String) -> Unit)

    private class Named(val name: String, val at: Long)

    private sealed interface Piece {
        data class Start(val message: BlobMessage.Start) : Piece

        data class Chunk(val base64: String) : Piece

        data object AllMissing : Piece

        data object Failed : Piece

        data object Cancelled : Piece

        data object Closed : Piece
    }

    private inner class Request(val token: String, val url: String, val origin: String, val asked: Map<Any, Frame>) {
        val pieces = LinkedBlockingQueue<Piece>(QUEUED_PIECES)
        var bound: Any? = null
        var boundSend: ((String) -> Unit)? = null
        val missing: MutableSet<Any> = java.util.Collections.newSetFromMap(java.util.IdentityHashMap())
        var awaiting = -1
        var ended = false
        var terminated = false

        fun finish(piece: Piece) {
            if (terminated) return
            terminated = true
            pieces.offer(piece)
        }

        fun heard(message: BlobMessage.ForRequest, key: Any, send: (String) -> Unit) {
            when (message) {
                is BlobMessage.Missing -> if (bound == null && asked.containsKey(key) && missing.add(key) && missing.size >= asked.size) finish(Piece.AllMissing)
                is BlobMessage.Start -> when {
                    bound == null && !terminated -> {
                        bound = key
                        boundSend = send
                        pieces.offer(Piece.Start(message))
                    }
                    bound !== key -> runCatching { send("${PageMadeDownloads.PREFIX}cancel $token") }
                }
                is BlobMessage.Chunk -> if (bound === key && message.index == awaiting) {
                    awaiting = -1
                    pieces.offer(Piece.Chunk(message.base64))
                }
                is BlobMessage.Fail -> if (bound === key) finish(Piece.Failed)
            }
        }
    }

    private val lock = Any()
    private val frames = LinkedHashMap<Any, Frame>()
    private val names = LinkedHashMap<String, Named>()
    private val requests = HashMap<String, Request>()

    internal val queuedPieces: Int get() = synchronized(lock) { requests.values.sumOf { it.pieces.size } }

    fun heard(text: String?, sourceOrigin: String, isMainFrame: Boolean, key: Any, send: (String) -> Unit): Boolean {
        if (text == null || !text.startsWith(PageMadeDownloads.PREFIX)) return false
        if (text.length - PageMadeDownloads.PREFIX.length > PageMadeDownloads.MAX_MESSAGE_CHARS) return true
        val origin = PageMadeDownloads.webOrigin(sourceOrigin) ?: return true
        val message = PageMadeDownloads.parse(text.substring(PageMadeDownloads.PREFIX.length)) ?: return true
        synchronized(lock) {
            when (message) {
                BlobMessage.Hello -> remember(key, Frame(origin, isMainFrame, send))
                is BlobMessage.Name -> {
                    val fromItsOrigin = if (PageMadeDownloads.isBlob(message.key)) PageMadeDownloads.blobOrigin(message.key) == origin else isMainFrame
                    if (fromItsOrigin) {
                        names.remove(message.key)
                        names[message.key] = Named(message.name, now())
                        while (names.size > MAX_NAMES) names.remove(names.keys.first())
                    }
                }
                is BlobMessage.ForRequest -> {
                    val request = requests[message.token]
                    when {
                        request != null && request.origin == origin -> request.heard(message, key, send)
                        message is BlobMessage.Start -> runCatching { send("${PageMadeDownloads.PREFIX}cancel ${message.token}") }
                    }
                }
            }
        }
        return true
    }

    private fun remember(key: Any, frame: Frame) {
        if (frame.isMain) frames.clear() else frames.remove(key)
        frames[key] = frame
        while (frames.size > MAX_FRAMES) {
            val oldest = frames.entries.firstOrNull { !it.value.isMain }?.key ?: break
            frames.remove(oldest)
        }
    }

    fun announcedName(url: String): String? {
        val key = PageMadeDownloads.nameKey(url) ?: return null
        synchronized(lock) {
            val named = names.remove(key) ?: return null
            return named.name.takeIf { now() - named.at <= NAME_KEEP_MILLIS }
        }
    }

    fun sourceFor(url: String): DownloadSource? {
        val origin = PageMadeDownloads.blobOrigin(url) ?: return null
        val known = synchronized(lock) { frames.values.any { it.origin == origin } }
        if (!known) return null
        return DownloadSource { call -> open(url, origin, call) }
    }

    fun reset() {
        synchronized(lock) {
            frames.clear()
            names.clear()
            for (request in requests.values) request.finish(Piece.Closed)
            requests.clear()
        }
    }

    private fun open(url: String, origin: String, call: DownloadCall): DownloadResponse {
        val token = PageMadeDownloads.newToken()
        val request = synchronized(lock) {
            val targets = frames.filterValues { it.origin == origin }
            if (targets.isEmpty()) throw DownloadRefused(DownloadFailure.Server)
            Request(token, url, origin, targets).also { requests[token] = it }
        }
        try {
            call.register {
                synchronized(lock) { request.finish(Piece.Cancelled) }
                end(request, "cancel")
            }
            onMain(Runnable { for (frame in request.asked.values) runCatching { frame.send("${PageMadeDownloads.PREFIX}fetch $token $url") } })
            val start = awaitStart(request, call)
            if (start.size > PageMadeDownloads.MAX_BYTES) throw DownloadRefused(DownloadFailure.Unsupported)
            val headers = buildMap<String, List<String>> {
                put("content-length", listOf(start.size.toString()))
                start.mimeType?.let { put("content-type", listOf(it)) }
                start.name?.let { put("content-disposition", listOf(PageMadeDownloads.dispositionFor(it))) }
            }
            return DownloadResponse(200, headers, Body(request, start.size, call)) { end(request, "done") }
        } catch (error: Exception) {
            end(request, "cancel")
            throw error
        }
    }

    private fun awaitStart(request: Request, call: DownloadCall): BlobMessage.Start {
        val deadline = now() + firstAnswerMillis
        while (true) {
            val left = deadline - now()
            val piece = if (left > 0) request.pieces.poll(left, TimeUnit.MILLISECONDS) else null
            when (piece) {
                is Piece.Start -> return piece.message
                Piece.AllMissing -> throw DownloadRefused(DownloadFailure.Server)
                Piece.Cancelled -> throw DownloadCancelled()
                null -> {
                    call.ensureActive()
                    val anyMissing = synchronized(lock) { request.missing.isNotEmpty() }
                    throw DownloadRefused(if (anyMissing) DownloadFailure.Server else DownloadFailure.Network)
                }
                else -> throw DownloadRefused(DownloadFailure.Network)
            }
        }
    }

    private fun end(request: Request, verb: String) {
        val sends = synchronized(lock) {
            if (request.ended) return
            request.ended = true
            requests.remove(request.token)
            val bound = request.bound
            request.asked.filterKeys { it !== bound }.values.map { it.send to "cancel" } +
                listOfNotNull(request.boundSend?.let { it to verb })
        }
        onMain(Runnable { for ((send, said) in sends) runCatching { send("${PageMadeDownloads.PREFIX}$said ${request.token}") } })
    }

    private inner class Body(private val request: Request, private val size: Long, private val call: DownloadCall) : InputStream() {
        private val deadline = now() + totalMillis
        private var received = 0L
        private var nextIndex = 0
        private var current = ByteArray(0)
        private var position = 0

        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (length == 0) return 0
            if (position >= current.size) {
                if (received >= size) return -1
                fill()
            }
            val count = minOf(length, current.size - position)
            System.arraycopy(current, position, buffer, offset, count)
            position += count
            return count
        }

        private fun fill() {
            call.ensureActive()
            if (now() > deadline) throw IOException("the page took too long")
            val index = nextIndex++
            val send = synchronized(lock) {
                if (request.ended) throw IOException("the request ended")
                request.awaiting = index
                request.boundSend
            } ?: throw IOException("no frame")
            onMain(Runnable { runCatching { send("${PageMadeDownloads.PREFIX}next ${request.token} $index") } })
            val wait = minOf(chunkIdleMillis, (deadline - now()).coerceAtLeast(1))
            when (val piece = request.pieces.poll(wait, TimeUnit.MILLISECONDS)) {
                is Piece.Chunk -> {
                    val bytes = PageMadeDownloads.decodeChunk(piece.base64) ?: throw IOException("a malformed chunk")
                    if (received + bytes.size > size) throw IOException("more bytes than the page declared")
                    received += bytes.size
                    current = bytes
                    position = 0
                }
                Piece.Cancelled -> throw DownloadCancelled()
                null -> {
                    call.ensureActive()
                    throw IOException("the page stopped answering")
                }
                else -> throw IOException("the page could not read the file")
            }
        }
    }

    companion object {
        const val FIRST_ANSWER_MILLIS = 5_000L
        const val CHUNK_IDLE_MILLIS = 15_000L
        const val TOTAL_MILLIS = 10 * 60_000L
        const val NAME_KEEP_MILLIS = 30_000L
        private const val MAX_FRAMES = 32
        private const val MAX_NAMES = 16
        private const val QUEUED_PIECES = 4
        private const val KEEP_AFTER_REVOKE_MILLIS = 60_000
        private const val KEPT_AFTER_REVOKE_BYTES = 64L * 1024 * 1024
        private const val KEPT_AFTER_REVOKE_COUNT = 16
        private const val SENDING_IDLE_MILLIS = 60_000

        val script: String = """
(() => {
  if (window.__ardiaBlobs || typeof ardiaPage === "undefined") return;
  Object.defineProperty(window, "__ardiaBlobs", { value: true });
  const bridge = ardiaPage;
  const prefix = "${PageMadeDownloads.PREFIX}";
  const chunkBytes = ${PageMadeDownloads.CHUNK_BYTES};
  const edge = ${PageMadeDownloads.DATA_KEY_EDGE};
  const keepAfterRevoke = $KEEP_AFTER_REVOKE_MILLIS;
  const keptBytesCap = $KEPT_AFTER_REVOKE_BYTES;
  const keptCountCap = $KEPT_AFTER_REVOKE_COUNT;
  const sendingIdle = $SENDING_IDLE_MILLIS;
  const made = new Map();
  const kept = [];
  let keptBytes = 0;
  const named = new Map();
  const sending = new Map();
  let sweeping = 0;
  const say = (text) => { try { bridge.postMessage(prefix + text); } catch (error) {} };
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  const forget = (key, entry) => {
    const at = kept.indexOf(entry);
    if (at >= 0) { kept.splice(at, 1); keptBytes -= entry.size; }
    if (made.get(key) === entry) made.delete(key);
  };
  URL.createObjectURL = function createObjectURL(object) {
    const url = create.call(URL, object);
    try {
      if (object instanceof Blob) {
        made.set(url, { key: url, blob: object, size: object.size, revoked: false });
        if (made.size > 256) for (const [key, entry] of made) { if (made.size <= 256) break; if (entry.revoked) forget(key, entry); }
      }
    } catch (error) {}
    return url;
  };
  URL.revokeObjectURL = function revokeObjectURL(url) {
    try {
      const key = String(url);
      const entry = made.get(key);
      if (entry && !entry.revoked) {
        entry.revoked = true;
        kept.push(entry);
        keptBytes += entry.size;
        while (kept.length > 1 && (keptBytes > keptBytesCap || kept.length > keptCountCap)) forget(kept[0].key, kept[0]);
        setTimeout(() => forget(key, entry), keepAfterRevoke);
      }
    } catch (error) {}
    return revoke.call(URL, url);
  };
  const note = (anchor) => {
    try {
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const name = anchor.getAttribute("download");
      const href = anchor.href;
      if (!name || typeof href !== "string") return;
      let key = null;
      if (href.startsWith("blob:")) { key = href; named.set(href, name); if (named.size > 32) named.delete(named.keys().next().value); }
      else if (href.startsWith("data:")) key = href.length + ":" + href.slice(0, edge) + ":" + href.slice(-edge);
      if (key) say("name " + encodeURIComponent(key) + " " + encodeURIComponent(name));
    } catch (error) {}
  };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { note(this); return click.apply(this, arguments); };
  const dispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event) {
    try { if (this instanceof HTMLAnchorElement && event instanceof MouseEvent && event.type === "click") note(this); } catch (error) {}
    return dispatch.apply(this, arguments);
  };
  addEventListener("click", (event) => {
    try {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      for (const node of path) if (node instanceof HTMLAnchorElement) { note(node); break; }
    } catch (error) {}
  }, true);
  const sweep = () => {
    sweeping = 0;
    const now = Date.now();
    for (const [token, entry] of sending) if (now - entry.at > sendingIdle) sending.delete(token);
    if (sending.size) sweeping = setTimeout(sweep, sendingIdle);
  };
  const hold = (token, blob) => {
    sending.set(token, { blob, at: Date.now() });
    if (!sweeping) sweeping = setTimeout(sweep, sendingIdle);
  };
  const answer = async (token, url) => {
    let blob = null;
    const entry = made.get(url);
    if (entry) blob = entry.blob;
    else {
      try {
        const response = await fetch(url);
        if (response.ok) blob = await response.blob();
      } catch (error) {}
    }
    if (!blob) { say("missing " + token); return; }
    hold(token, blob);
    const name = (typeof File !== "undefined" && blob instanceof File && blob.name) || named.get(url) || "";
    say("start " + token + " " + blob.size + " " + encodeURIComponent(blob.type || "") + " " + encodeURIComponent(name));
  };
  const send = (token, index) => {
    const entry = sending.get(token);
    if (!entry || !(index >= 0)) { say("fail " + token); return; }
    entry.at = Date.now();
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      say("chunk " + token + " " + index + " " + text.slice(text.indexOf(",") + 1));
    };
    reader.onerror = () => { sending.delete(token); say("fail " + token); };
    reader.readAsDataURL(entry.blob.slice(index * chunkBytes, (index + 1) * chunkBytes));
  };
  bridge.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    if (!data.startsWith(prefix)) return;
    const parts = data.slice(prefix.length).split(" ");
    const verb = parts[0];
    const token = parts[1];
    if (verb === "fetch") answer(token, parts.slice(2).join(" "));
    else if (verb === "next") send(token, Number(parts[2]));
    else if (verb === "done" || verb === "cancel") sending.delete(token);
  });
  addEventListener("pagehide", () => {
    for (const token of sending.keys()) say("fail " + token);
    sending.clear();
  });
  addEventListener("pageshow", (event) => { if (event.persisted) say("hello"); });
  say("hello");
})();
""".trim()
    }
}
