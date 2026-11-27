package com.ardia.browser

import java.io.IOException
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.random.Random
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PageBlobsTest {
    private val prefix = PageMadeDownloads.PREFIX
    private var clock = 0L
    private val blobs = PageBlobs(onMain = { it.run() }, firstAnswerMillis = 1_000, chunkIdleMillis = 1_000, now = { System.nanoTime() / 1_000_000 + clock })

    private inner class Frame(val origin: String, val files: Map<String, ByteArray> = emptyMap(), val answers: Boolean = true, val main: Boolean = false, val type: String = "text/plain", val name: String = "") {
        val heard = LinkedBlockingQueue<String>()
        private val serving = HashMap<String, ByteArray>()

        fun hello() = say("hello")

        fun say(text: String) = blobs.heard(prefix + text, origin, main, this, ::received)

        fun next(verb: String): List<String> {
            while (true) {
                val message = heard.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("the page never heard $verb")
                val parts = message.removePrefix(prefix).split(" ")
                if (parts[0] == verb) return parts
            }
        }

        private fun received(message: String) {
            heard.offer(message)
            if (!answers) return
            val parts = message.removePrefix(prefix).split(" ")
            when (parts[0]) {
                "fetch" -> {
                    val bytes = files[parts[2]]
                    if (bytes == null) {
                        say("missing ${parts[1]}")
                    } else {
                        serving[parts[1]] = bytes
                        say("start ${parts[1]} ${bytes.size} ${encode(type)} ${encode(name)}")
                    }
                }
                "next" -> {
                    val bytes = serving[parts[1]] ?: return
                    val index = parts[2].toInt()
                    val from = index * PageMadeDownloads.CHUNK_BYTES
                    val slice = bytes.copyOfRange(from, minOf(bytes.size, from + PageMadeDownloads.CHUNK_BYTES))
                    say("chunk ${parts[1]} $index ${Base64.getEncoder().encodeToString(slice)}")
                }
            }
        }
    }

    private fun encode(value: String) = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun openAsync(url: String, call: DownloadCall = DownloadCall()): CompletableFuture<DownloadResponse> {
        val source = blobs.sourceFor(url) ?: error("no source for $url")
        return CompletableFuture.supplyAsync { source.open(call) }
    }

    private fun readAsync(response: DownloadResponse): CompletableFuture<ByteArray> = CompletableFuture.supplyAsync { response.body.readBytes() }

    private fun <T> CompletableFuture<T>.cause(): Throwable = try {
        get(10, TimeUnit.SECONDS)
        fail("expected a failure")
        error("unreachable")
    } catch (error: ExecutionException) {
        error.cause!!
    }

    @Test
    fun aBlobTheFrameMadeComesBackInChunksWithItsTypeAndName() {
        val url = "blob:https://eligrey.com/cf30724d-1"
        val bytes = Random(7).nextBytes(PageMadeDownloads.CHUNK_BYTES * 2 + 1234)
        val frame = Frame("https://eligrey.com", mapOf(url to bytes), type = "image/png", name = "canvas.png").also { it.hello() }
        val response = openAsync(url).get(10, TimeUnit.SECONDS)
        assertEquals(bytes.size.toLong(), response.contentLength)
        assertEquals("image/png", response.header("content-type"))
        assertEquals("canvas.png", DownloadRules.dispositionName(response.header("content-disposition")))
        response.use { assertArrayEquals(bytes, it.body.readBytes()) }
        assertEquals(3, frame.heard.count { it.startsWith("${prefix}next ") })
        assertTrue(frame.heard.any { it.startsWith("${prefix}done ") })
    }

    @Test
    fun anEmptyBlobFinishesWithoutAskingForChunks() {
        val url = "blob:https://a.example/empty"
        val frame = Frame("https://a.example", mapOf(url to ByteArray(0))).also { it.hello() }
        val response = openAsync(url).get(10, TimeUnit.SECONDS)
        assertEquals(0, response.body.readBytes().size)
        assertFalse(frame.heard.any { it.startsWith("${prefix}next ") })
    }

    @Test
    fun onlyFramesOfTheBlobsOriginAreAskedAndOnlyTheyCanAnswer() {
        val url = "blob:https://a.example/1"
        val owner = Frame("https://a.example", answers = false).also { it.hello() }
        val stranger = Frame("https://ads.example", answers = false).also { it.hello() }
        val pending = openAsync(url)
        val token = owner.next("fetch")[1]
        assertTrue(stranger.heard.isEmpty())
        stranger.say("start $token 4 text%2Fplain evil.apk")
        stranger.say("missing $token")
        owner.say("start $token 2 text%2Fplain ok.txt")
        val response = pending.get(10, TimeUnit.SECONDS)
        assertEquals("ok.txt", DownloadRules.dispositionName(response.header("content-disposition")))
        val body = readAsync(response)
        assertEquals("0", owner.next("next")[2])
        stranger.say("chunk $token 0 ZXZpbA==")
        owner.say("chunk $token 0 b2s=")
        assertEquals("ok", String(body.get(10, TimeUnit.SECONDS)))
    }

    @Test
    fun aSecondSameOriginFrameThatAnswersLateIsToldToStop() {
        val url = "blob:https://a.example/1"
        val first = Frame("https://a.example", answers = false).also { it.hello() }
        val second = Frame("https://a.example", answers = false).also { it.hello() }
        val pending = openAsync(url)
        val token = first.next("fetch")[1]
        assertEquals(token, second.next("fetch")[1])
        first.say("start $token 2  ")
        second.say("start $token 2  ")
        assertEquals(token, second.next("cancel")[1])
        val body = readAsync(pending.get(10, TimeUnit.SECONDS))
        first.next("next")
        second.say("chunk $token 0 bm8=")
        first.say("chunk $token 0 b2s=")
        assertEquals("ok", String(body.get(10, TimeUnit.SECONDS)))
    }

    @Test
    fun chunksOutOfTurnOrRepeatedAreDropped() {
        val url = "blob:https://a.example/1"
        val frame = Frame("https://a.example", answers = false).also { it.hello() }
        val pending = openAsync(url)
        val token = frame.next("fetch")[1]
        frame.say("start $token 4  ")
        val body = readAsync(pending.get(10, TimeUnit.SECONDS))
        frame.next("next")
        frame.say("chunk $token 1 enp6")
        frame.say("chunk $token 0 b2s=")
        frame.say("chunk $token 0 enp6")
        frame.next("next")
        frame.say("chunk $token 1 b2s=")
        assertEquals("okok", String(body.get(10, TimeUnit.SECONDS)))
    }

    @Test
    fun aRevokedBlobFailsAsServerOnceEveryFrameSaysItIsMissing() {
        Frame("https://a.example").also { it.hello() }
        Frame("https://a.example").also { it.hello() }
        val started = System.nanoTime()
        val error = openAsync("blob:https://a.example/gone").cause()
        assertEquals(DownloadFailure.Server, (error as DownloadRefused).failure)
        assertTrue((System.nanoTime() - started) / 1_000_000 < 900)
    }

    @Test
    fun framesThatNeverAnswerFailAsNetworkAtTheDeadline() {
        Frame("https://a.example", answers = false).also { it.hello() }
        val started = System.nanoTime()
        val error = openAsync("blob:https://a.example/1").cause()
        assertEquals(DownloadFailure.Network, (error as DownloadRefused).failure)
        assertTrue((System.nanoTime() - started) / 1_000_000 < 3_000)
    }

    @Test
    fun aBlobOverTheCapIsRefusedAsUnsupported() {
        val frame = Frame("https://a.example", answers = false).also { it.hello() }
        val pending = openAsync("blob:https://a.example/1")
        val token = frame.next("fetch")[1]
        frame.say("start $token ${PageMadeDownloads.MAX_BYTES + 1}  ")
        assertEquals(DownloadFailure.Unsupported, (pending.cause() as DownloadRefused).failure)
        assertEquals(token, frame.next("cancel")[1])
    }

    @Test
    fun morePagesBytesThanDeclaredOrAMalformedChunkFail() {
        for (chunk in listOf("b2tvaw==", "!!!!", "b2s")) {
            val frame = Frame("https://a.example", answers = false).also { it.hello() }
            val pending = openAsync("blob:https://a.example/1")
            val token = frame.next("fetch")[1]
            frame.say("start $token 2  ")
            val body = readAsync(pending.get(10, TimeUnit.SECONDS))
            frame.next("next")
            frame.say("chunk $token 0 $chunk")
            assertTrue(chunk, body.cause() is IOException)
        }
    }

    @Test
    fun thePageGoingAwayFailsTheRead() {
        val frame = Frame("https://a.example", answers = false).also { it.hello() }
        val pending = openAsync("blob:https://a.example/1")
        val token = frame.next("fetch")[1]
        frame.say("start $token 2  ")
        val body = readAsync(pending.get(10, TimeUnit.SECONDS))
        frame.next("next")
        frame.say("fail $token")
        assertTrue(body.cause() is IOException)
    }

    @Test
    fun aPageThatStopsSendingFailsAtTheIdleDeadline() {
        val frame = Frame("https://a.example", answers = false).also { it.hello() }
        val pending = openAsync("blob:https://a.example/1")
        val token = frame.next("fetch")[1]
        frame.say("start $token 2  ")
        val body = readAsync(pending.get(10, TimeUnit.SECONDS))
        assertTrue(body.cause() is IOException)
    }

    @Test
    fun theTabClosingFailsReadsInFlightAndForgetsItsFrames() {
        val frame = Frame("https://a.example", answers = false).also { it.hello() }
        val pending = openAsync("blob:https://a.example/1")
        val token = frame.next("fetch")[1]
        frame.say("start $token 2  ")
        val body = readAsync(pending.get(10, TimeUnit.SECONDS))
        frame.next("next")
        blobs.reset()
        assertTrue(body.cause() is IOException)
        assertNull(blobs.sourceFor("blob:https://a.example/1"))
    }

    @Test
    fun cancellingTheCallEndsTheReadAndTellsThePage() {
        val frame = Frame("https://a.example", answers = false).also { it.hello() }
        val call = DownloadCall()
        val pending = openAsync("blob:https://a.example/1", call)
        val token = frame.next("fetch")[1]
        frame.say("start $token 2  ")
        val body = readAsync(pending.get(10, TimeUnit.SECONDS))
        frame.next("next")
        call.cancel()
        assertTrue(body.cause() is DownloadCancelled)
        assertEquals(token, frame.next("cancel")[1])
    }

    @Test
    fun cancellingBeforeAnyAnswerEndsTheWait() {
        val frame = Frame("https://a.example", answers = false).also { it.hello() }
        val call = DownloadCall()
        val pending = openAsync("blob:https://a.example/1", call)
        frame.next("fetch")
        call.cancel()
        assertTrue(pending.cause() is DownloadCancelled)
    }

    @Test
    fun withoutAFrameOfThatOriginThereIsNoSource() {
        assertNull(blobs.sourceFor("blob:https://a.example/1"))
        Frame("null").hello()
        assertNull(blobs.sourceFor("blob:null/1"))
        Frame("https://b.example").hello()
        assertNull(blobs.sourceFor("blob:https://a.example/1"))
        assertNull(blobs.sourceFor("https://b.example/1"))
        assertNotNull(blobs.sourceFor("blob:https://b.example/1"))
    }

    @Test
    fun theFrameListStaysBoundedButNeverDropsTheTopFrame() {
        Frame("https://top.example", main = true).hello()
        Frame("https://first.example").hello()
        repeat(40) { Frame("https://f$it.example").hello() }
        assertNotNull(blobs.sourceFor("blob:https://top.example/1"))
        assertNull(blobs.sourceFor("blob:https://first.example/1"))
        assertNotNull(blobs.sourceFor("blob:https://f39.example/1"))
    }

    @Test
    fun aNewTopDocumentReplacesTheOldTopFrameAndIframesLeaveWhenTheySayBye() {
        val oldTop = Frame("https://old.example", main = true).also { it.hello() }
        val ads = Frame("https://ads.example").also { it.hello() }
        Frame("https://new.example", main = true).hello()
        assertNull(blobs.sourceFor("blob:https://old.example/1"))
        assertNotNull(blobs.sourceFor("blob:https://new.example/1"))
        assertNotNull(blobs.sourceFor("blob:https://ads.example/1"))
        ads.say("bye")
        assertNull(blobs.sourceFor("blob:https://ads.example/1"))
        oldTop.say("bye")
        assertNotNull(blobs.sourceFor("blob:https://new.example/1"))
    }

    @Test
    fun iframesThatWentAwayDoNotCrowdOutALiveOne() {
        Frame("https://top.example", main = true).hello()
        Frame("https://reports.example").hello()
        repeat(40) {
            val passing = Frame("https://ad$it.example")
            passing.hello()
            passing.say("bye")
        }
        assertNotNull(blobs.sourceFor("blob:https://reports.example/1"))
        assertNull(blobs.sourceFor("blob:https://ad0.example/1"))
    }

    @Test
    fun aNameTooLongToCarryStillLetsTheDownloadStart() {
        val url = "blob:https://a.example/1"
        val frame = Frame("https://a.example", answers = false).also { it.hello() }
        val pending = openAsync(url)
        val token = frame.next("fetch")[1]
        val name = encode("\uD83C\uDF89".repeat(257) + ".txt")
        assertTrue(name.length > PageMadeDownloads.MAX_NAME_FIELD_CHARS)
        frame.say("start $token 2 text%2Fplain $name")
        val response = pending.get(10, TimeUnit.SECONDS)
        assertEquals(2L, response.contentLength)
        assertNull(response.header("content-disposition"))
    }

    @Test
    fun oneFrameRepeatingMissingDoesNotSpeakForTheOthers() {
        val url = "blob:https://a.example/1"
        val empty = Frame("https://a.example", answers = false).also { it.hello() }
        val owner = Frame("https://a.example", answers = false).also { it.hello() }
        val pending = openAsync(url)
        val token = empty.next("fetch")[1]
        owner.next("fetch")
        repeat(3) { empty.say("missing $token") }
        owner.say("start $token 2  ")
        assertEquals(2L, pending.get(10, TimeUnit.SECONDS).contentLength)
    }

    @Test
    fun repeatedRepliesNeverQueueUp() {
        val url = "blob:https://a.example/1"
        val owner = Frame("https://a.example", answers = false).also { it.hello() }
        val other = Frame("https://a.example", answers = false).also { it.hello() }
        val pending = openAsync(url)
        val token = owner.next("fetch")[1]
        owner.say("start $token 2  ")
        val response = pending.get(10, TimeUnit.SECONDS)
        repeat(10_000) {
            owner.say("fail $token")
            owner.say("start $token 2  ")
            other.say("start $token 2  ")
            other.say("missing $token")
        }
        assertTrue("${blobs.queuedPieces} pieces queued", blobs.queuedPieces <= 1)
        assertTrue(readAsync(response).cause() is IOException)
    }

    @Test
    fun cancellingBeforeAnyAnswerTellsEveryFrameAsked() {
        val first = Frame("https://a.example", answers = false).also { it.hello() }
        val second = Frame("https://a.example", answers = false).also { it.hello() }
        val call = DownloadCall()
        val pending = openAsync("blob:https://a.example/1", call)
        val token = first.next("fetch")[1]
        second.next("fetch")
        call.cancel()
        assertTrue(pending.cause() is DownloadCancelled)
        assertEquals(token, first.next("cancel")[1])
        assertEquals(token, second.next("cancel")[1])
    }

    @Test
    fun aFrameThatAnswersAfterTheRequestEndedIsToldToLetGo() {
        val url = "blob:https://a.example/1"
        val owner = Frame("https://a.example", mapOf(url to "ok".toByteArray())).also { it.hello() }
        val late = Frame("https://a.example", answers = false).also { it.hello() }
        val response = openAsync(url).get(10, TimeUnit.SECONDS)
        response.use { assertEquals("ok", String(it.body.readBytes())) }
        val token = late.next("fetch")[1]
        assertEquals(token, late.next("cancel")[1])
        late.say("start $token 2  ")
        assertEquals(token, late.next("cancel")[1])
        assertTrue(owner.heard.any { it == "${prefix}done $token" })
    }

    @Test
    fun anOversizedMessageIsDroppedBeforeItIsParsed() {
        val frame = Frame("https://a.example", answers = false).also { it.hello() }
        val pending = openAsync("blob:https://a.example/1")
        val token = frame.next("fetch")[1]
        frame.say("start $token 2 " + " ".repeat(PageMadeDownloads.MAX_MESSAGE_CHARS) + "x")
        frame.say("name " + "a ".repeat(1_000_000))
        assertEquals(DownloadFailure.Network, (pending.cause() as DownloadRefused).failure)
    }

    @Test
    fun namesComeOnlyFromTheBlobsOwnOriginOrTheTopFrameForDataAndExpire() {
        val blob = "blob:https://a.example/1"
        val data = "data:text/plain,hello"
        val dataKey = PageMadeDownloads.nameKey(data)!!
        Frame("https://ads.example").say("name ${encode(blob)} evil.apk")
        assertNull(blobs.announcedName(blob))
        Frame("https://a.example").say("name ${encode(blob)} report%20final.pdf")
        assertEquals("report final.pdf", blobs.announcedName(blob))
        assertNull(blobs.announcedName(blob))
        Frame("https://ads.example", main = false).say("name ${encode(dataKey)} evil.apk")
        assertNull(blobs.announcedName(data))
        Frame("https://a.example", main = true).say("name ${encode(dataKey)} hello.txt")
        assertEquals("hello.txt", blobs.announcedName(data))
        Frame("https://a.example").say("name ${encode(blob)} late.txt")
        clock += PageBlobs.NAME_KEEP_MILLIS + 1
        assertNull(blobs.announcedName(blob))
    }

    @Test
    fun messagesWithoutThePrefixAreLeftForTheOtherScripts() {
        assertFalse(blobs.heard("nightShade", "https://a.example", true, this) {})
        assertFalse(blobs.heard(null, "https://a.example", true, this) {})
        assertTrue(blobs.heard("${prefix}garbage", "https://a.example", true, this) {})
        assertTrue(blobs.heard("${prefix}hello", "null", true, this) {})
        assertNull(blobs.sourceFor("blob:null/1"))
    }
}
