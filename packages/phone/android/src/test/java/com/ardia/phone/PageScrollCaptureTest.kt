package com.ardia.phone

import android.graphics.Rect
import android.os.Looper
import android.webkit.WebView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PageScrollCaptureTest {
    private val noPage = object : PageScrollCapture.Host {
        override fun capturableWebView(): WebView? = null

        override fun scrollBounds(): Rect = Rect(0, 0, 1080, 2000)
    }

    @Test
    fun theSystemCallbackHandsNullArgumentsOnWithoutKotlinsNullChecks() {
        val callback = PageScrollCallback(PageScrollCapture(noPage))
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
    fun aTileRequestTheSystemSendsWithoutItsSessionSignalOrAreaAnswersEmptyInsteadOfCrashing() {
        val capture = PageScrollCapture(noPage)
        val answers = mutableListOf<Rect>()
        capture.request(null, null, Rect(0, 0, 1080, 1180)) { answers.add(it) }
        capture.request(null, null, null) { answers.add(it) }
        capture.request(null, null, null, null)
        assertEquals(2, answers.size)
        assertTrue(answers.all { it.isEmpty })
    }

    @Test
    fun aPageThatCantBeCapturedIsNeverOffered() {
        val capture = PageScrollCapture(noPage)
        val offered = mutableListOf<Rect>()
        capture.search(null) { offered.add(it) }
        capture.search(null, null)
        assertEquals(1, offered.size)
        assertTrue(offered.single().isEmpty)
    }

    @Test
    fun startAndEndWithoutTheirArgumentsStillAnswerTheSystem() {
        val capture = PageScrollCapture(noPage)
        var started = 0
        var ended = 0
        capture.start(null) { started += 1 }
        capture.start(null, null)
        shadowOf(Looper.getMainLooper()).idle()
        capture.end { ended += 1 }
        capture.end(null)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, started)
        assertEquals(1, ended)
        val answers = mutableListOf<Rect>()
        capture.request(null, null, Rect(0, 0, 1080, 1180)) { answers.add(it) }
        assertTrue(answers.single().isEmpty)
    }
}
