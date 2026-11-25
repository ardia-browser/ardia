package com.ardia.browser

import android.content.Context
import android.graphics.Bitmap
import android.os.Looper
import android.webkit.WebBackForwardList
import android.webkit.WebHistoryItem
import android.webkit.WebView
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WebViewPageHistoryGuardTest {
    private lateinit var context: Context
    private lateinit var engine: DevelopmentWebViewEngine
    private lateinit var page: WebViewPage
    private lateinit var webView: FakeHistoryWebView

    private class FakeHistoryItem(private val urlValue: String) : WebHistoryItem() {
        override fun getUrl(): String = urlValue
        override fun getOriginalUrl(): String = urlValue
        override fun getTitle(): String = urlValue
        override fun getFavicon(): Bitmap? = null
        override fun clone(): FakeHistoryItem = FakeHistoryItem(urlValue)
    }

    private class FakeBackForwardList : WebBackForwardList() {
        private val items = listOf(
            FakeHistoryItem("https://example.com/one"),
            FakeHistoryItem("https://example.com/two"),
        )
        override fun getCurrentItem(): WebHistoryItem = items[1]
        override fun getCurrentIndex(): Int = 1
        override fun getItemAtIndex(index: Int): WebHistoryItem? = items.getOrNull(index)
        override fun getSize(): Int = items.size
        override fun clone(): WebBackForwardList = FakeBackForwardList()
    }

    private class FakeHistoryWebView(context: Context) : WebView(context) {
        var canGoBackResult = true
        var fakeHeight = 800

        override fun canGoBackOrForward(steps: Int): Boolean = if (steps < 0) canGoBackResult else false

        override fun canGoBack(): Boolean = canGoBackResult

        override fun copyBackForwardList(): WebBackForwardList = FakeBackForwardList()

        override fun goBackOrForward(steps: Int) = Unit

        override fun canScrollVertically(direction: Int): Boolean = true
    }

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        engine = DevelopmentWebViewEngine(context)
        page = WebViewPage(
            id = "tab-1",
            isPrivate = false,
            engine = engine,
            setup = PageSetup.fresh("https://example.com/two", VisitKind.Typed),
            popup = null,
        )
        webView = FakeHistoryWebView(context).apply {
            layout(0, 0, 400, fakeHeight)
        }
        val field = WebViewPage::class.java.getDeclaredField("webView")
        field.isAccessible = true
        field.set(page, webView)
    }

    @After
    fun tearDown() {
        page.discard()
    }

    @Test
    fun historyScrollRestorationAcrossPageStartedAndPageFinishedKeepsScrollDirectionUp() {
        page.scrolled(webView, 0)
        page.scrolled(webView, 500)
        assertEquals(ScrollDirection.Down, page.state.value.scrollDirection)

        page.goBack()
        assertEquals(ScrollDirection.Up, page.state.value.scrollDirection)

        page.pageStarted(webView, "https://example.com/one")
        assertEquals(ScrollDirection.Up, page.state.value.scrollDirection)

        page.scrolled(webView, 1200)
        assertEquals(ScrollDirection.Up, page.state.value.scrollDirection)

        page.pageFinished(webView, "https://example.com/one")
        page.scrolled(webView, 1250)
        assertEquals(ScrollDirection.Up, page.state.value.scrollDirection)

        shadowOf(Looper.getMainLooper()).idleFor(600, TimeUnit.MILLISECONDS)
        page.scrolled(webView, 1300)
        assertEquals(ScrollDirection.Down, page.state.value.scrollDirection)
    }
}
