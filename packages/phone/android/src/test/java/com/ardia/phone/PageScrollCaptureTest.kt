package com.ardia.phone

import android.graphics.Bitmap
import android.graphics.HardwareRenderer
import android.graphics.Rect
import android.os.Looper
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PageScrollCaptureTest {
    private class FakePage : CapturePage {
        override val width = 1080
        override val height = 2000
        override var scrollY = 3000
        override val attached = true
        override val scale = 1.0
        override val documentHeight = 12_000.0
        override var scrollBarShown = true
        var marked = false
        var restoredTo: Int? = null
        var draws = 0
        var onPaint: (() -> Unit)? = null

        fun reload() {
            marked = false
        }

        private fun body(source: String) = source.substringBefore("'ARDIA_CAPTURE_KEY'")

        private fun y(script: String) = script.substringAfterLast(",").removeSuffix(")").toDoubleOrNull()

        override suspend fun evaluate(script: String, waitMillis: Long): Int? = when {
            script == PageScrollScripts.ZOOMED -> 0
            script.startsWith(body(PageScrollScripts.MARK)) -> if (marked) 0 else 1.also { marked = true }
            script.startsWith(body(PageScrollScripts.OWNS)) -> if (marked) 1 else 0
            script.startsWith(body(PageScrollScripts.HIDE_FIXED)) -> if (marked) 1 else -1
            script.startsWith(body(PageScrollScripts.SCROLL)) -> if (!marked) -1 else y(script)!!.toInt().also { scrollY = it }
            script.startsWith(body(PageScrollScripts.SHOW_FIXED)) -> if (!marked) -1 else 1.also { y(script)?.toInt()?.let { to -> scrollY = to; restoredTo = to } }
            script.startsWith(body(PageScrollScripts.DROP)) -> if (marked) 1.also { marked = false } else 0
            else -> null
        }

        override suspend fun awaitPaint() {
            onPaint?.invoke()
            onPaint = null
        }

        override suspend fun draw(region: Rect): Bitmap {
            draws += 1
            return Bitmap.createBitmap(region.width(), region.height(), Bitmap.Config.ARGB_8888)
        }
    }

    private class FakeHost(var page: CapturePage?) : PageScrollCapture.Host {
        override fun capturablePage(): CapturePage? = page

        override fun scrollBounds(): Rect = Rect(0, 0, 1080, 2000)
    }

    private class FakeSurface(vararg results: Int?) : TileSurface {
        private val queue = ArrayDeque(results.toList())
        var presents = 0

        override fun present(shot: Bitmap, width: Int): Int? {
            presents += 1
            return if (queue.isEmpty()) HardwareRenderer.SYNC_OK else queue.removeFirst()
        }
    }

    private val startTile = Rect(0, 0, 1080, 1000)
    private val belowTile = Rect(0, 2000, 1080, 3000)

    private fun opened(page: FakePage = FakePage(), host: FakeHost = FakeHost(page)): Triple<PageScrollCapture, FakePage, FakeHost> {
        val capture = PageScrollCapture(host)
        runBlocking { capture.open() }
        assertTrue(page.marked)
        return Triple(capture, page, host)
    }

    @Test
    fun aRepeatedTileIsNotPublishedOnceTheDocumentReloaded() = runBlocking {
        val (capture, page) = opened()
        val surface = FakeSurface()
        assertFalse(capture.tile(1080, startTile, surface).isEmpty)
        assertEquals(1, surface.presents)
        page.reload()
        assertTrue(capture.tile(1080, startTile, surface).isEmpty)
        assertEquals(1, surface.presents)
        assertTrue(capture.tile(1080, belowTile, surface).isEmpty)
        assertEquals(1, surface.presents)
    }

    @Test
    fun aNavigationDuringThePaintWaitIsNeverPublished() = runBlocking {
        val (capture, page) = opened()
        val surface = FakeSurface()
        page.onPaint = { page.reload() }
        assertTrue(capture.tile(1080, belowTile, surface).isEmpty)
        assertEquals(0, surface.presents)
        assertEquals(1, page.draws)
    }

    @Test
    fun aPageThatStopsBeingCapturableMidSessionIsNeverPublishedAndIsPutBack() = runBlocking {
        val (capture, page, host) = opened()
        val surface = FakeSurface()
        assertFalse(capture.tile(1080, belowTile, surface).isEmpty)
        assertEquals(5000, page.scrollY)
        host.page = null
        assertTrue(capture.tile(1080, belowTile, surface).isEmpty)
        assertEquals(1, surface.presents)
        assertEquals(3000, page.restoredTo)
        assertFalse("the session's token is dropped", page.marked)
        assertTrue(page.scrollBarShown)
    }

    @Test
    fun aFrameDroppedOrLostTwiceAnswersEmptyAndEndsTheSession() = runBlocking {
        for (bad in listOf(HardwareRenderer.SYNC_FRAME_DROPPED, HardwareRenderer.SYNC_LOST_SURFACE_REWARD_IF_FOUND, HardwareRenderer.SYNC_CONTEXT_IS_STOPPED, null)) {
            val (capture, page) = opened()
            val surface = FakeSurface(bad, bad)
            assertTrue("$bad", capture.tile(1080, startTile, surface).isEmpty)
            assertEquals("$bad", 2, surface.presents)
            assertEquals("$bad", 3000, page.restoredTo)
            assertTrue("$bad", capture.tile(1080, startTile, FakeSurface()).isEmpty)
        }
    }

    @Test
    fun aFrameDroppedOnceIsPresentedAgainAndKept() = runBlocking {
        val (capture) = opened()
        val surface = FakeSurface(HardwareRenderer.SYNC_FRAME_DROPPED, HardwareRenderer.SYNC_REDRAW_REQUESTED)
        assertFalse(capture.tile(1080, startTile, surface).isEmpty)
        assertEquals(2, surface.presents)
    }

    @Test
    fun aRepeatedTileOfTheSameDocumentIsPresentedAgainWithoutDrawingThePage() = runBlocking {
        val (capture, page) = opened()
        val surface = FakeSurface()
        val first = capture.tile(1080, startTile, surface)
        val again = capture.tile(1080, startTile, surface)
        assertEquals(first, again)
        assertEquals(2, surface.presents)
        assertEquals(1, page.draws)
    }

    @Test
    fun theSystemCallbackHandsNullArgumentsOnWithoutKotlinsNullChecks() {
        val callback = PageScrollCallback(PageScrollCapture(FakeHost(null)))
        val answers = mutableListOf<Rect>()
        val sink = java.util.function.Consumer<Rect> { answers.add(it) }
        val request = PageScrollCallback::class.java.getMethod("onScrollCaptureImageRequest", android.view.ScrollCaptureSession::class.java, android.os.CancellationSignal::class.java, Rect::class.java, java.util.function.Consumer::class.java)
        request.invoke(callback, null, null, null, sink)
        PageScrollCallback::class.java.getMethod("onScrollCaptureSearch", android.os.CancellationSignal::class.java, java.util.function.Consumer::class.java).invoke(callback, null, sink)
        PageScrollCallback::class.java.getMethod("onScrollCaptureStart", android.view.ScrollCaptureSession::class.java, android.os.CancellationSignal::class.java, Runnable::class.java).invoke(callback, null, null, null)
        PageScrollCallback::class.java.getMethod("onScrollCaptureEnd", Runnable::class.java).invoke(callback, null)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(2, answers.size)
        assertTrue(answers.all { it.isEmpty })
    }

    @Test
    fun aPageThatCantBeCapturedIsNeverOfferedNorStarted() {
        val capture = PageScrollCapture(FakeHost(null))
        val offered = mutableListOf<Rect>()
        capture.search(null) { offered.add(it) }
        capture.search(null, null)
        var started = 0
        var ended = 0
        capture.start(null) { started += 1 }
        capture.start(null, null)
        shadowOf(Looper.getMainLooper()).idle()
        capture.end { ended += 1 }
        capture.end(null)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(offered.single().isEmpty)
        assertEquals(1, started)
        assertEquals(1, ended)
        assertTrue(runBlocking { capture.tile(1080, Rect(0, 0, 1080, 1000), FakeSurface()) }.isEmpty)
    }

    @Test
    fun aSessionTheSystemNeverEndsIsEndedAndPutBackOnceItGoesQuiet() {
        val page = FakePage()
        val capture = PageScrollCapture(FakeHost(page), idleLimitMillis = 3_000)
        runBlocking { capture.open() }
        assertFalse(runBlocking { capture.tile(1080, belowTile, FakeSurface()) }.isEmpty)
        assertEquals(5000, page.scrollY)
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(2_000))
        assertFalse(runBlocking { capture.tile(1080, belowTile, FakeSurface()) }.isEmpty)
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(2_000))
        assertEquals("a request two seconds in keeps the session open", null, page.restoredTo)
        assertTrue(page.marked)
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(1_500))
        assertEquals(3000, page.restoredTo)
        assertFalse(page.marked)
        assertTrue(page.scrollBarShown)
        assertTrue(runBlocking { capture.tile(1080, belowTile, FakeSurface()) }.isEmpty)
    }
}
