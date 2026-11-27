package com.ardia.browser

import android.content.Context
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

object DownloadHarness {
    fun run(downloads: SystemDownloads, download: PageDownload): DownloadOutcome = runBlocking {
        val id = downloads.enqueue(download)
        check(id != null) { "the download was not started" }
        withTimeout(30_000) { downloads.outcomes.first() }
    }

    fun contents(context: Context, outcome: DownloadOutcome): String? {
        val uri = (outcome as? DownloadOutcome.Finished)?.uri ?: return null
        return context.contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
    }

    fun delete(context: Context, outcome: DownloadOutcome?) {
        val uri = (outcome as? DownloadOutcome.Finished)?.uri ?: return
        runCatching { context.contentResolver.delete(uri, null, null) }
    }
}

@RunWith(AndroidJUnit4::class)
class SystemDownloadsTest {
    private val harness = PageHarness()
    private val server = harness.server
    private val created = ArrayList<DownloadOutcome>()

    @After
    fun tearDown() {
        created.forEach { DownloadHarness.delete(harness.context, it) }
        harness.close()
    }

    private fun download(url: String, fileName: String, isPrivate: Boolean = false, mimeType: String? = null) = PageDownload(
        url = url,
        fileName = fileName,
        mimeType = mimeType,
        contentLength = -1,
        userAgent = "ArdiaTest",
        contentDisposition = null,
        referer = null,
        isPrivate = isPrivate,
    )

    private fun hostedOnLocalhost(path: String) = "http://localhost:${server.port}$path"

    @Test
    fun aRedirectToAnotherHostCarriesNoCookies() {
        server.route("/login") {
            TestServer.Response(body = "<title>In</title>", headers = mapOf("Set-Cookie" to "session=secret; Path=/"))
        }
        server.route("/statement") { TestServer.Response(302, headers = mapOf("Location" to hostedOnLocalhost("/collect"))) }
        server.route("/collect") { TestServer.Response(body = "statement body", contentType = "application/pdf") }
        val page = harness.open("tab", "/login")
        harness.awaitTitle(page, "In")
        assertEquals("session=secret", onMain { harness.engine.cookieHeader(server.url("/statement"), isPrivate = false) })
        assertNull(onMain { harness.engine.cookieHeader(hostedOnLocalhost("/collect"), isPrivate = false) })

        val outcome = DownloadHarness.run(SystemDownloads(harness.context, harness.engine), download(server.url("/statement"), "statement.pdf"))
        created += outcome
        assertTrue("$outcome", outcome is DownloadOutcome.Finished)
        assertEquals("statement body", DownloadHarness.contents(harness.context, outcome))
        val first = server.requests.last { it.path == "/statement" }
        val second = server.requests.last { it.path == "/collect" }
        assertEquals("session=secret", first.headers["cookie"])
        assertEquals("localhost:${server.port}", second.headers["host"])
        assertNull(second.headers["cookie"])
        assertEquals("ArdiaTest", second.headers["user-agent"])
    }

    private fun relativePath(outcome: DownloadOutcome): String? {
        val uri = (outcome as DownloadOutcome.Finished).uri!!
        return harness.context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.RELATIVE_PATH), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }

    @Test
    fun theFileLandsInDownloadsWithASafeUniqueName() {
        server.route("/file") { TestServer.Response(body = "one", contentType = "text/plain") }
        val downloads = SystemDownloads(harness.context, harness.engine)
        val first = DownloadHarness.run(downloads, download(server.url("/file"), "../../secret/notes.txt", mimeType = "text/plain"))
        created += first
        val second = DownloadHarness.run(downloads, download(server.url("/file"), "notes.txt", mimeType = "text/plain"))
        created += second
        assertTrue(first is DownloadOutcome.Finished && second is DownloadOutcome.Finished)
        assertTrue(first.fileName, first.fileName.startsWith("notes") && !first.fileName.contains('/'))
        assertFalse(second.fileName.contains('/'))
        assertNotEquals(first.fileName, second.fileName)
        assertEquals("Download/", relativePath(first))
        assertEquals("Download/", relativePath(second))
        assertTrue(downloads.active.value.isEmpty())
    }

    @Test
    fun aLinkedFileTakesItsNameFromTheResponseSafeAndUnique() {
        server.route("/file") { TestServer.Response(body = "one", contentType = "text/plain") }
        val downloads = SystemDownloads(harness.context, harness.engine)
        val first = DownloadHarness.run(downloads, download(server.url("/file"), "../../secret/notes.txt"))
        created += first
        val second = DownloadHarness.run(downloads, download(server.url("/file"), "../../secret/notes.txt"))
        created += second
        assertTrue(first is DownloadOutcome.Finished && second is DownloadOutcome.Finished)
        assertEquals("a link with no type or disposition is named from the response, as Download Linked File is", "file.txt", first.fileName)
        assertFalse(second.fileName.contains('/'))
        assertNotEquals(first.fileName, second.fileName)
        assertEquals("Download/", relativePath(first))
        assertEquals("Download/", relativePath(second))
        assertTrue(downloads.active.value.isEmpty())
    }

    @Test
    fun aMissingFileFailsAndLeavesNothingBehind() {
        val downloads = SystemDownloads(harness.context, harness.engine)
        val outcome = DownloadHarness.run(downloads, download(server.url("/nothing-here"), "gone.txt"))
        assertEquals(DownloadOutcome.Failed("gone.txt", DownloadFailure.Server), outcome)
        assertTrue(downloads.active.value.isEmpty())
    }

    @Test
    fun aBlobNoFrameCanServeAndOtherSchemesAreRefusedAsUnsupported() {
        val downloads = SystemDownloads(harness.context, harness.engine)
        assertEquals(DownloadStart.Refused(DownloadFailure.Unsupported), downloads.start(download("blob:http://127.0.0.1/1", "a.bin")))
        assertEquals(DownloadStart.Refused(DownloadFailure.Unsupported), downloads.start(download("ftp://127.0.0.1/a.txt", "a.txt")))
        assertEquals(DownloadStart.Refused(DownloadFailure.Unsupported), downloads.start(download("data:text/plain", "a.txt")))
        assertNull(downloads.enqueue(download("javascript:alert(1)", "a.txt")))
    }

    @Test
    fun aDataAddressIsDecodedAndSavedWithTheNameThePageGave() {
        val downloads = SystemDownloads(harness.context, harness.engine)
        val named = download("data:text/plain;base64,aGVsbG8gd29ybGQ=", "downloadfile.txt")
            .copy(contentDisposition = PageMadeDownloads.dispositionFor("greeting.txt"))
        val outcome = DownloadHarness.run(downloads, named).also(created::add)
        assertEquals("greeting.txt", outcome.fileName)
        assertEquals("hello world", DownloadHarness.contents(harness.context, outcome))
        val guessed = DownloadHarness.run(downloads, download("data:image/svg+xml,%3Csvg%2F%3E", "downloadfile.bin")).also(created::add)
        assertEquals("downloadfile.svg", guessed.fileName)
        assertEquals("<svg/>", DownloadHarness.contents(harness.context, guessed))
    }

    @Test
    fun aMalformedDataAddressFailsAndLeavesNothingBehind() {
        val downloads = SystemDownloads(harness.context, harness.engine)
        val outcome = DownloadHarness.run(downloads, download("data:;base64,a", "broken.txt"))
        assertEquals(DownloadOutcome.Failed("broken.txt", DownloadFailure.Unsupported), outcome)
    }

    @Test
    fun aPageSourceIsSavedThroughTheSameEntryAndKeepsThePrivateFlag() {
        val downloads = SystemDownloads(harness.context, harness.engine)
        val bytes = ByteArray(300_000) { (it % 251).toByte() }
        val source = DownloadSource {
            DownloadResponse(
                200,
                mapOf(
                    "content-type" to listOf("image/png"),
                    "content-length" to listOf(bytes.size.toString()),
                    "content-disposition" to listOf(PageMadeDownloads.dispositionFor("canvas")),
                ),
                bytes.inputStream(),
            )
        }
        val outcome = DownloadHarness.run(downloads, download("blob:https://a.example/cf30724d", "cf30724d.bin").copy(source = source)).also(created::add)
        assertEquals("canvas.png", outcome.fileName)
        val uri = (outcome as DownloadOutcome.Finished).uri!!
        assertTrue(harness.context.contentResolver.openInputStream(uri)!!.use { it.readBytes() }.contentEquals(bytes))
        assertFalse(outcome.isPrivate)
        val failing = DownloadSource { throw DownloadRefused(DownloadFailure.Server) }
        val failed = DownloadHarness.run(downloads, download("blob:https://a.example/gone", "gone.bin", isPrivate = true).copy(source = failing))
        assertEquals(DownloadOutcome.Failed("gone.bin", DownloadFailure.Server, isPrivate = true), failed)
    }

    @Test
    fun onlyThreeRunAtOnceAndTheRestWaitTheirTurn() {
        val release = CountDownLatch(1)
        for (index in 1..4) {
            server.route("/slow$index") {
                release.await(20, TimeUnit.SECONDS)
                TestServer.Response(body = "file $index", contentType = "text/plain")
            }
        }
        val downloads = SystemDownloads(harness.context, harness.engine)
        for (index in 1..4) assertNotNull(downloads.enqueue(download(server.url("/slow$index"), "slow$index.txt")))
        harness.poll { server.requests.count { it.path.startsWith("/slow") }.takeIf { it >= 3 } }
        val waiting = harness.poll { downloads.active.value.takeIf { list -> list.size == 4 && list.count { !it.isQueued } == 3 } }
        assertEquals(1, waiting.count { it.isQueued })
        Thread.sleep(500)
        assertEquals(3, server.requests.count { it.path.startsWith("/slow") })
        release.countDown()
        val outcomes = runBlocking { withTimeout(30_000) { downloads.outcomes.take(4).toList() } }
        created += outcomes
        assertTrue("$outcomes", outcomes.all { it is DownloadOutcome.Finished })
        assertEquals(4, server.requests.count { it.path.startsWith("/slow") })
    }

    @Test
    fun aCancelDuringAHeldRedirectStopsAtOnceAndNeverFollowsIt() {
        val release = CountDownLatch(1)
        server.route("/held") {
            release.await(20, TimeUnit.SECONDS)
            TestServer.Response(302, headers = mapOf("Location" to server.url("/after")))
        }
        server.route("/after") { TestServer.Response(body = "after", contentType = "text/plain") }
        val downloads = SystemDownloads(harness.context, harness.engine)
        val id = downloads.enqueue(download(server.url("/held"), "held.txt"))!!
        harness.poll { server.requested("/held").takeIf { it } }
        downloads.cancel(id)
        assertTrue(downloads.active.value.none { it.id == id })
        release.countDown()
        Thread.sleep(1_000)
        assertFalse(server.requested("/after"))
        assertNull(runBlocking { withTimeoutOrNull(1_000) { downloads.outcomes.first() } })
    }

    @Test
    fun aBodyThatNeverEndsStopsWhenSpaceRunsOutAndLeavesNoFile() {
        server.route("/endless") { TestServer.Response(contentType = "application/octet-stream", endlessBody = true) }
        val checks = AtomicLong()
        val fakeFree = { DownloadRules.SPACE_RESERVE_BYTES + 12L * 1024 * 1024 - checks.getAndIncrement() * DownloadRules.SPACE_CHECK_BYTES }
        val downloads = SystemDownloads(harness.context, freeSpace = fakeFree)
        val outcome = DownloadHarness.run(downloads, download(server.url("/endless"), "endless-${System.nanoTime()}.bin"))
        assertEquals(DownloadFailure.NoSpace, (outcome as DownloadOutcome.Failed).reason)
        assertTrue(checks.get() >= 3)
        assertFalse(storedNames().any { it.startsWith(outcome.fileName.substringBefore('.')) })
        assertTrue(downloads.active.value.isEmpty())
    }

    @Test
    fun aCancelWhileCookiesAreLookedUpSendsNoRequest() {
        server.route("/quiet") { TestServer.Response(body = "quiet", contentType = "text/plain") }
        val inLookup = CountDownLatch(1)
        val release = CountDownLatch(1)
        val slowCookies = DownloadCookies { _, _ ->
            inLookup.countDown()
            release.await(10, TimeUnit.SECONDS)
            "session=secret"
        }
        val downloads = SystemDownloads(harness.context, slowCookies)
        val id = downloads.enqueue(download(server.url("/quiet"), "quiet.txt"))!!
        assertTrue(inLookup.await(10, TimeUnit.SECONDS))
        downloads.cancel(id)
        release.countDown()
        Thread.sleep(1_000)
        assertFalse(server.requested("/quiet"))
        assertTrue(downloads.active.value.isEmpty())
        assertNull(runBlocking { withTimeoutOrNull(500) { downloads.outcomes.first() } })
    }

    @Test
    fun aPrivateSessionEndingRightBeforePublishLeavesNothingInDownloads() {
        val name = "private-${System.nanoTime()}.txt"
        var bodyEnded = false
        var checksAfterBody = 0
        val sessions = object : DownloadSessions {
            override fun privateCookieHeader(url: String, session: String): String? = null

            override fun isPrivateSessionLive(session: String): Boolean = !bodyEnded || ++checksAfterBody <= 1

            override fun addPrivateSessionEndListener(listener: (String) -> Unit): AutoCloseable? = null
        }
        val body = object : java.io.InputStream() {
            private var left = "hello".toByteArray().inputStream()

            override fun read(): Int = left.read().also { if (it < 0) bodyEnded = true }

            override fun read(buffer: ByteArray, offset: Int, length: Int): Int = left.read(buffer, offset, length).also { if (it < 0) bodyEnded = true }
        }
        val source = DownloadSource { DownloadResponse(200, mapOf("content-length" to listOf("5"), "content-type" to listOf("text/plain")), body) }
        val downloads = SystemDownloads(harness.context, sessions = sessions)
        val held = download("blob:https://a.example/p", name, isPrivate = true).copy(privateSession = "s1", source = source)
        val outcome = DownloadHarness.run(downloads, held).also(created::add)
        assertEquals(DownloadOutcome.Failed(name, DownloadFailure.PrivateSessionEnded, isPrivate = true), outcome)
        assertFalse(name in storedNames())
    }

    private fun storedNames(): Set<String> {
        val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val arguments = Bundle().apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_INCLUDE)
        }
        return harness.context.contentResolver.query(collection, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), arguments, null)?.use { cursor ->
            buildSet { while (cursor.moveToNext()) cursor.getString(0)?.let(::add) }
        }.orEmpty()
    }
}
