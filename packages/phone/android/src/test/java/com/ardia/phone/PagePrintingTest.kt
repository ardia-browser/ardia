package com.ardia.phone

import android.app.Activity
import android.graphics.Bitmap
import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout
import com.ardia.browser.FindResult
import com.ardia.browser.FullscreenVideo
import com.ardia.browser.Page
import com.ardia.browser.PageEvent
import com.ardia.browser.PageRequest
import com.ardia.browser.PageState
import com.ardia.browser.PageTone
import com.ardia.browser.ReadableContent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PagePrintingTest {
    private class StillPage(url: String?, title: String, shown: View?) : Page {
        override val id = "page"
        override val isPrivate = false
        override val state: StateFlow<PageState> = MutableStateFlow(PageState(url = url, title = title))
        override val view: StateFlow<View?> = MutableStateFlow(shown)
        override val request: StateFlow<PageRequest?> = MutableStateFlow(null)
        override val find: StateFlow<FindResult?> = MutableStateFlow(null)
        override val fullscreen: StateFlow<FullscreenVideo?> = MutableStateFlow(null)
        override val events: SharedFlow<PageEvent> = MutableSharedFlow()
        override fun load(url: String) = Unit
        override fun reload() = Unit
        override fun stop() = Unit
        override fun goBack() = false
        override fun goForward() = false
        override fun find(text: String) = Unit
        override fun findNext() = Unit
        override fun findPrevious() = Unit
        override fun endFind() = Unit
        override fun setPageZoom(zoom: Double) = Unit
        override fun zoomIn() = Unit
        override fun zoomOut() = Unit
        override fun setDesktopSite(enabled: Boolean) = Unit
        override fun download(url: String) = Unit
        override suspend fun readableContent(): ReadableContent = throw UnsupportedOperationException()
        override suspend fun snapshot(maxWidth: Int, windowCopy: Boolean): Bitmap? = null
        override suspend fun sampleTone(topInset: Int, bottomInset: Int): PageTone? = null
        override fun saveState(): ByteArray? = null
        override fun close() = Unit
    }

    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    @Test
    fun theJobIsNamedByTheTitleThenTheHostThenTheAddress() {
        assertEquals("Lisbon - Wikipedia", PagePrinting.jobName("  Lisbon - Wikipedia ", "https://en.wikipedia.org/wiki/Lisbon"))
        assertEquals("en.wikipedia.org", PagePrinting.jobName("", "https://en.wikipedia.org/wiki/Lisbon"))
        assertEquals("about:blank", PagePrinting.jobName(" ", "about:blank"))
    }

    @Test
    fun onlyWebPagesPrintAsOnIPhone() {
        assertTrue(PagePrinting.printable("https://example.com"))
        assertTrue(PagePrinting.printable("HTTP://example.com"))
        assertFalse(PagePrinting.printable("ardia://start"))
        assertFalse(PagePrinting.printable("file:///sdcard/a.html"))
        assertFalse(PagePrinting.printable(null))
    }

    @Test
    fun theStartPageAndAPageWithoutAWebViewAreRefused() {
        assertFalse(PagePrinting.print(activity, StillPage("ardia://start", "", WebView(activity))))
        assertFalse(PagePrinting.print(activity, StillPage("https://example.com", "Example", null)))
        assertFalse(PagePrinting.print(activity, StillPage("https://example.com", "Example", FrameLayout(activity))))
    }

    @Test
    fun aWebPageOpensTheSystemPrintSheet() {
        assertTrue(PagePrinting.print(activity, StillPage("https://example.com", "Example", FrameLayout(activity).apply { addView(WebView(activity)) })))
    }
}
