package com.ardia.phone

import com.ardia.browser.TouchScrollers
import com.ardia.browsing.SwipeDirection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PageDragDecisionTest {
    private fun decide(
        mode: SwipeMode = SwipeMode.Anywhere,
        pull: Boolean = true,
        dx: Float = 0f,
        dy: Float = 0f,
        startX: Float = 500f,
        canGoBack: Boolean = true,
        canGoForward: Boolean = true,
        canScrollLeft: Boolean = false,
        canScrollRight: Boolean = false,
        canScrollUp: Boolean = false,
        isLoading: Boolean = false,
        closesPastBack: Boolean = false,
        reopensPastForward: Boolean = false,
    ) = PageDragDecision.decide(mode, pull, dx, dy, startX, 1080f, 72f, canGoBack, canGoForward, canScrollLeft, canScrollRight, canScrollUp, isLoading, closesPastBack, reopensPastForward)

    @Test
    fun aSidewaysDragGoesBackOrForwardOnlyWhenThePageCannotScrollThatWay() {
        assertEquals(PageDragDecision.Decided(PageDragDecision.Drag.Swipe, SwipeDirection.Back), decide(dx = 60f, dy = 5f))
        assertEquals(PageDragDecision.Decided(PageDragDecision.Drag.Swipe, SwipeDirection.Forward), decide(dx = -60f, dy = 5f))
        assertNull(decide(dx = 60f, dy = 5f, canScrollLeft = true))
        assertNull(decide(dx = -60f, dy = 5f, canScrollRight = true))
        assertNull(decide(dx = 60f, dy = 5f, canGoBack = false))
        assertNull(decide(dx = 60f, dy = 50f))
    }

    @Test
    fun edgesModeTakesOnlyDragsThatStartAtAnEdgeAndOffTakesNone() {
        assertNull(decide(mode = SwipeMode.Edges, dx = 60f, startX = 500f))
        assertEquals(SwipeDirection.Back, decide(mode = SwipeMode.Edges, dx = 60f, startX = 20f)?.direction)
        assertEquals(SwipeDirection.Forward, decide(mode = SwipeMode.Edges, dx = -60f, startX = 1070f)?.direction)
        assertNull(decide(mode = SwipeMode.Off, dx = 60f))
        assertEquals(SwipeMode.Off, SwipeMode.of("unknown"))
        assertEquals(SwipeMode.Edges, SwipeMode.of("edges"))
    }

    @Test
    fun aSwipePastTheHistoryRunsOnlyWhenItCanCloseOrReopenATab() {
        assertEquals(SwipeDirection.Back, decide(dx = 60f, dy = 5f, canGoBack = false, closesPastBack = true)?.direction)
        assertEquals(SwipeDirection.Forward, decide(dx = -60f, dy = 5f, canGoForward = false, reopensPastForward = true)?.direction)
        assertNull(decide(dx = -60f, dy = 5f, canGoForward = false, closesPastBack = true))
        assertNull(decide(dx = 60f, dy = 5f, canGoBack = false, closesPastBack = true, canScrollLeft = true))
        assertNull(decide(mode = SwipeMode.Edges, dx = 60f, startX = 500f, canGoBack = false, closesPastBack = true))
        assertEquals(SwipeDirection.Back, decide(mode = SwipeMode.Edges, dx = 60f, startX = 20f, canGoBack = false, closesPastBack = true)?.direction)
        assertNull(decide(mode = SwipeMode.Off, dx = 60f, canGoBack = false, closesPastBack = true, pull = false))
        assertEquals(true, com.ardia.browsing.PageSwipe.isPastHistory(SwipeDirection.Back, canGoBack = false, canGoForward = true))
        assertEquals(false, com.ardia.browsing.PageSwipe.isPastHistory(SwipeDirection.Forward, canGoBack = false, canGoForward = true))
    }

    @Test
    fun aDownwardDragRefreshesOnlyAtTheTopOfAPageThatIsNotLoading() {
        assertEquals(PageDragDecision.Decided(PageDragDecision.Drag.Pull, null), decide(dy = 40f, dx = 2f))
        assertNull(decide(dy = 40f, canScrollUp = true))
        assertNull(decide(dy = 40f, isLoading = true))
        assertNull(decide(dy = 40f, pull = false))
        assertNull(decide(dy = -40f))
        assertEquals(PageDragDecision.Drag.Pull, decide(mode = SwipeMode.Off, dy = 40f)?.drag)
    }

    private fun settle(claimed: Boolean = false, scroller: Boolean? = false, travelledDp: Float, millis: Long, density: Float = 2.75f) =
        PageDragDecision.settle(contentClaimed = claimed, scrollerTakes = scroller, travelledPx = travelledDp * density, millisSinceSlop = millis, density = density)

    @Test
    fun aSidewaysDragWaitsForThePageToSayItsContentTookItBeforeNavigating() {
        assertEquals(PageDragDecision.Settle.Wait, settle(travelledDp = 5f, millis = 10L))
        assertEquals(PageDragDecision.Settle.Wait, settle(travelledDp = 40f, millis = 20L))
        assertEquals(PageDragDecision.Settle.Wait, settle(travelledDp = 2f, millis = 500L))
        assertEquals(PageDragDecision.Settle.Claim, settle(travelledDp = 14f, millis = 90L))
        assertEquals(PageDragDecision.Settle.Yield, settle(claimed = true, travelledDp = 40f, millis = 500L))
    }

    @Test
    fun aScrollerUnderTheFingerThatCanScrollThatWayKeepsTheDragEvenIfTheWebViewSaysNothing() {
        assertEquals(PageDragDecision.Settle.Yield, settle(scroller = true, travelledDp = 2f, millis = 0L))
        assertEquals(PageDragDecision.Settle.Yield, settle(scroller = true, travelledDp = 40f, millis = 500L))
        assertEquals(PageDragDecision.Settle.Wait, settle(scroller = null, travelledDp = 14f, millis = 90L))
        assertEquals(PageDragDecision.Settle.Claim, settle(scroller = null, travelledDp = 14f, millis = PageDragDecision.REPORT_WAIT_MILLIS))
        assertEquals(PageDragDecision.Settle.Claim, settle(scroller = false, travelledDp = 14f, millis = 90L))
    }

    @Test
    fun goingBackNeedsAScrollerThatCanScrollLeftAndForwardOneThatCanScrollRight() {
        val atStart = TouchScrollers.Report(canScrollLeft = false, canScrollRight = true, atMillis = 0L)
        val midway = TouchScrollers.Report(canScrollLeft = true, canScrollRight = true, atMillis = 0L)
        assertEquals(false, PageDragDecision.scrollerTakes(SwipeDirection.Back, atStart))
        assertEquals(true, PageDragDecision.scrollerTakes(SwipeDirection.Forward, atStart))
        assertEquals(true, PageDragDecision.scrollerTakes(SwipeDirection.Back, midway))
        assertEquals(null, PageDragDecision.scrollerTakes(SwipeDirection.Back, null))
    }

    @Test
    fun thePageReportsTheScrollerUnderTheFingerAndAnOlderTouchsReportIsIgnored() {
        assertEquals(TouchScrollers.Report(true, false, 7L), TouchScrollers.parse("touchScroller:100", 7L))
        assertEquals(TouchScrollers.Report(false, false, 7L, canScrollUp = true), TouchScrollers.parse("touchScroller:001", 7L))
        assertNull(TouchScrollers.parse("touchScroller:10", 7L))
        assertNull(TouchScrollers.parse("touchScroller:1x0", 7L))
        assertNull(TouchScrollers.parse("nightShade", 7L))
        val key = Any()
        assertEquals(false, TouchScrollers.everReported(key))
        TouchScrollers.report(key, "touchScroller:110", 100L)
        assertEquals(true, TouchScrollers.everReported(key))
        assertEquals(true, TouchScrollers.since(key, 90L)?.canScrollLeft)
        assertNull(TouchScrollers.since(key, 120L))
        assertNull(TouchScrollers.since(Any(), 0L))
    }

    @Test
    fun aPullWaitsForThePageAndLeavesTheDragToAScrollerThatCanScrollUp() {
        val atTop = TouchScrollers.Report(false, false, 0L, canScrollUp = false)
        val scrolledDown = TouchScrollers.Report(false, false, 0L, canScrollUp = true)
        assertEquals(PageDragDecision.Settle.Yield, PageDragDecision.settlePull(false, scrolledDown, true, 0L))
        assertEquals(PageDragDecision.Settle.Yield, PageDragDecision.settlePull(true, atTop, true, 0L))
        assertEquals(PageDragDecision.Settle.Claim, PageDragDecision.settlePull(false, atTop, true, 0L))
        assertEquals(PageDragDecision.Settle.Wait, PageDragDecision.settlePull(false, null, true, 50L))
        assertEquals(PageDragDecision.Settle.Claim, PageDragDecision.settlePull(false, null, true, PageDragDecision.REPORT_WAIT_MILLIS))
        assertEquals(PageDragDecision.Settle.Claim, PageDragDecision.settlePull(false, null, false, 0L))
    }

    @Test
    fun aBigInnerScrollerReportsItsOffsetAndBadReportsAreDropped() {
        assertEquals(TouchScrollers.InnerScroll("ab12cd.3", 840.0, false), TouchScrollers.parseInnerScroll("innerScroll:ab12cd.3:840:0"))
        assertEquals(TouchScrollers.InnerScroll("ab12cd.3", 0.0, true), TouchScrollers.parseInnerScroll("innerScroll:ab12cd.3:0:1"))
        assertNull(TouchScrollers.parseInnerScroll("innerScroll:ab12cd.3:-4:0"))
        assertNull(TouchScrollers.parseInnerScroll("innerScroll:ab12cd.3:12.5:0"))
        assertNull(TouchScrollers.parseInnerScroll("innerScroll:ab/cd:12:0"))
        assertNull(TouchScrollers.parseInnerScroll("innerScroll::12:0"))
        assertNull(TouchScrollers.parseInnerScroll("innerScroll:a:12:2"))
        assertNull(TouchScrollers.parseInnerScroll("innerScroll:a:12"))
        assertNull(TouchScrollers.parseInnerScroll("touchScroller:100"))
    }
}
