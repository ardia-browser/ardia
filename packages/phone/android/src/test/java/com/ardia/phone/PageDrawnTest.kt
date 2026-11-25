package com.ardia.phone

import android.app.Activity
import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PageDrawnTest {
    private class Surface : DrawnSurface {
        var shown = false
        var hasWebView = true
        val visualStates = ArrayList<() -> Unit>()
        val commits = ArrayList<() -> Unit>()

        override fun visible() = shown

        override fun postVisualState(done: () -> Unit): Boolean {
            if (!hasWebView) return false
            visualStates += done
            return true
        }

        override fun afterNextFrameCommits(done: () -> Unit) {
            commits += done
        }
    }

    private val surface = Surface()
    private var drawn = 0
    private var document = 1L
    private val drawnDocuments = ArrayList<Long>()
    private val watch = PageDrawnWatch(surface, document = { document }) { generation ->
        drawn += 1
        drawnDocuments += generation
    }

    @Test
    fun aHiddenPageAsksTheWebViewForNothing() {
        watch.frame()
        watch.frame()
        assertTrue(surface.visualStates.isEmpty())
        assertEquals(PageDrawnWatch.Stage.Hidden, watch.stage)
    }

    @Test
    fun drawnIsReportedOnceTheFrameWithTheWebViewsContentIsCommittedAfterItBecameVisible() {
        watch.frame()
        surface.shown = true
        watch.frame()
        assertEquals("asked once when it became visible", 1, surface.visualStates.size)
        watch.frame()
        assertEquals("not asked again while waiting", 1, surface.visualStates.size)
        surface.visualStates.single()()
        assertEquals("the WebView being ready to draw isn't the frame being presented", 0, drawn)
        surface.commits.single()()
        assertEquals(1, drawn)
        watch.frame()
        assertEquals("a page that stays visible reports once", 1, surface.visualStates.size)
        assertEquals(1, drawn)
    }

    @Test
    fun aPageHiddenWhileWaitingReportsNothingFromThatWait() {
        surface.shown = true
        watch.frame()
        surface.shown = false
        watch.frame()
        surface.visualStates.single()()
        assertTrue(surface.commits.isEmpty())
        surface.shown = true
        watch.frame()
        surface.visualStates[surface.visualStates.lastIndex]()
        surface.commits.single()()
        assertEquals(1, drawn)
    }

    @Test
    fun aPageHiddenBetweenReadyAndCommitReportsNothingFromThatWait() {
        surface.shown = true
        watch.frame()
        surface.visualStates.single()()
        surface.shown = false
        watch.frame()
        surface.commits.single()()
        assertEquals(0, drawn)
    }

    @Test
    fun showingAgainAfterBeingHiddenReportsAgain() {
        surface.shown = true
        watch.frame()
        surface.visualStates.single()()
        surface.commits.single()()
        surface.shown = false
        watch.frame()
        surface.shown = true
        watch.frame()
        surface.visualStates[surface.visualStates.lastIndex]()
        surface.commits[surface.commits.lastIndex]()
        assertEquals(2, drawn)
    }

    @Test
    fun aNewWebViewIsWaitedForAgain() {
        surface.shown = true
        watch.frame()
        surface.visualStates.single()()
        watch.reset()
        surface.commits.single()()
        assertEquals("the old WebView's frame doesn't count", 0, drawn)
        watch.frame()
        surface.visualStates[surface.visualStates.lastIndex]()
        surface.commits[surface.commits.lastIndex]()
        assertEquals(1, drawn)
    }

    @Test
    fun withoutAWebViewItKeepsLookingEachFrame() {
        surface.shown = true
        surface.hasWebView = false
        watch.frame()
        assertEquals(PageDrawnWatch.Stage.Hidden, watch.stage)
        surface.hasWebView = true
        watch.frame()
        assertEquals(PageDrawnWatch.Stage.Waiting, watch.stage)
    }

    @Test
    fun aParentAtOpacityZeroHidesThePage() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val page = View(activity)
        val cover = FrameLayout(activity).apply { addView(page) }
        val root = FrameLayout(activity).apply { addView(cover) }
        activity.setContentView(root)
        assertEquals(1f, PageDrawnWatch.shownAlpha(page))
        cover.alpha = 0f
        assertEquals(0f, PageDrawnWatch.shownAlpha(page))
        cover.alpha = 0.5f
        page.alpha = 0.5f
        assertEquals(0.25f, PageDrawnWatch.shownAlpha(page))
    }

    @Test
    fun theWebViewIsFoundInsideThePagesWrapper() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val web = WebView(activity)
        val wrapper = FrameLayout(activity).apply { addView(FrameLayout(activity).apply { addView(web) }) }
        assertSame(web, PageDrawnWatch.webViewIn(wrapper))
        assertSame(web, PageDrawnWatch.webViewIn(web))
        assertNull(PageDrawnWatch.webViewIn(FrameLayout(activity)))
        assertNull(PageDrawnWatch.webViewIn(null))
    }

    @Test
    fun aDrawOfADocumentThatWasReplacedMeanwhileIsNotReportedAndTheNewDocumentIsAskedFor() {
        surface.shown = true
        watch.frame()
        document = 2L
        surface.visualStates.single()()
        assertEquals("asked again for the new document", 2, surface.visualStates.size)
        assertTrue(surface.commits.isEmpty())
        surface.visualStates[surface.visualStates.size - 1]()
        document = 3L
        surface.commits.single()()
        assertEquals("a frame committed after another replacement isn't that document's either", 0, drawn)
        surface.visualStates[surface.visualStates.size - 1]()
        surface.commits[surface.commits.size - 1]()
        assertEquals(listOf(3L), drawnDocuments)
    }
}
