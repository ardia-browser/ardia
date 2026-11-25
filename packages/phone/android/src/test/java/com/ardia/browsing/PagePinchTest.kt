package com.ardia.browsing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PagePinchTest {
    private fun moment(page: String = "p1", document: Long = 3, webScale: Float = 2.625f, visible: Boolean = true, loading: Boolean = false, dragging: Boolean = false) =
        PagePinch.Moment(page, document, webScale, visible, loading, dragging)

    private fun pinch(vararg scales: Double, from: PagePinch.Moment = moment(), atMinimum: Boolean? = true): PagePinch {
        val made = assertNotNullAndGet(PagePinch.begin(from))
        atMinimum?.let { made.measuredStart(it, from.webScale) }
        for (scale in scales) made.moved(scale)
        return made
    }

    private fun assertNotNullAndGet(pinch: PagePinch?): PagePinch {
        assertNotNull(pinch)
        return pinch!!
    }

    @Test
    fun aDeliberateInwardPinchThatLeftTheWebViewAtItsMinimumZoomFires() {
        assertTrue(pinch(0.98, 0.8, 0.6, 0.5).fires(PagePinch.Ending.Ended, moment(), endsAtMinimum = true))
    }

    @Test
    fun neverStartsOnHiddenLoadingOrDraggedPages() {
        assertNull(PagePinch.begin(moment(visible = false)))
        assertNull(PagePinch.begin(moment(loading = true)))
        assertNull(PagePinch.begin(moment(dragging = true)))
        assertNull(PagePinch.begin(moment(webScale = Float.NaN)))
    }

    @Test
    fun aPinchThatZoomedTheWebViewOutIsTheWebViewsAndNeverFires() {
        val zoomedOut = pinch(0.8, 0.5)
        assertFalse(zoomedOut.fires(PagePinch.Ending.Ended, moment(webScale = 1.8f), endsAtMinimum = true))
        assertTrue(zoomedOut.fires(PagePinch.Ending.Ended, moment(webScale = 2.63f), endsAtMinimum = true))
    }

    @Test
    fun aPinchFromAZoomedInPageNeverFiresEvenWhenTheWebViewScaleHeld() {
        assertFalse(pinch(0.5, atMinimum = false).fires(PagePinch.Ending.Ended, moment(), endsAtMinimum = true))
        assertFalse(pinch(0.5, atMinimum = null).fires(PagePinch.Ending.Ended, moment(), endsAtMinimum = true))
        assertFalse(pinch(0.5).fires(PagePinch.Ending.Ended, moment(), endsAtMinimum = false))
    }

    @Test
    fun theStartMeasurementCountsOnlyWhileTheWebViewStillHasTheScaleLatchedAtTouchDown() {
        val zoomedBeforeTheReply = assertNotNullAndGet(PagePinch.begin(moment()))
        zoomedBeforeTheReply.measuredStart(atRest = true, scaleWhenMeasured = 2.1f)
        zoomedBeforeTheReply.moved(0.5)
        assertEquals(false, zoomedBeforeTheReply.startedAtMinimum)
        assertFalse(zoomedBeforeTheReply.fires(PagePinch.Ending.Ended, moment(), endsAtMinimum = true))
        val held = assertNotNullAndGet(PagePinch.begin(moment()))
        held.measuredStart(atRest = true, scaleWhenMeasured = 2.63f)
        held.measuredStart(atRest = false, scaleWhenMeasured = 2.63f)
        assertEquals(true, held.startedAtMinimum)
        assertFalse(PagePinch.keptZoom(2.625f, Float.NaN))
    }

    @Test
    fun outwardAtAnyPointNeverFires() {
        val outThenIn = pinch(1.5, 1.2, 0.9, 0.5)
        assertTrue(outThenIn.wentOutward)
        assertFalse(outThenIn.fires(PagePinch.Ending.Ended, moment(), endsAtMinimum = true))
    }

    @Test
    fun aReversalBackTowardsRestOrAShallowPinchDoesNotFire() {
        assertFalse(pinch(0.7, 0.45, 0.68).fires(PagePinch.Ending.Ended, moment(), endsAtMinimum = true))
        assertTrue(pinch(0.6, 0.5, 0.55).fires(PagePinch.Ending.Ended, moment(), endsAtMinimum = true))
        assertFalse(pinch(0.9, 0.8).fires(PagePinch.Ending.Ended, moment(), endsAtMinimum = true))
    }

    @Test
    fun aCancelledTouchNeverFires() {
        val made = pinch(0.5)
        assertFalse(made.isDeliberate(PagePinch.Ending.Cancelled))
        assertFalse(made.fires(PagePinch.Ending.Cancelled, moment(), endsAtMinimum = true))
    }

    @Test
    fun aNavigationReloadTabSwitchOrDragDuringThePinchDoesNotFire() {
        val made = pinch(0.5)
        assertFalse(made.fires(PagePinch.Ending.Ended, moment(document = 4), endsAtMinimum = true))
        assertFalse(made.fires(PagePinch.Ending.Ended, moment(loading = true), endsAtMinimum = true))
        assertFalse(made.fires(PagePinch.Ending.Ended, moment(page = "p2"), endsAtMinimum = true))
        assertFalse(made.fires(PagePinch.Ending.Ended, moment(visible = false), endsAtMinimum = true))
        assertFalse(made.fires(PagePinch.Ending.Ended, moment(dragging = true), endsAtMinimum = true))
    }

    @Test
    fun ignoresNonsenseScales() {
        val made = pinch(0.5)
        made.moved(Double.NaN)
        made.moved(0.0)
        made.moved(-1.0)
        assertEquals(0.5, made.lastScale, 0.0)
        assertTrue(made.fires(PagePinch.Ending.Ended, moment(), endsAtMinimum = true))
    }

    @Test
    fun theVisualViewportRestsAtMinimumWhenItCoversTheLayoutViewportIncludingADesktopOverview() {
        assertTrue(PagePinch.restsAtMinimum("[412,412]"))
        assertTrue(PagePinch.restsAtMinimum("[980,980]"))
        assertTrue(PagePinch.restsAtMinimum("[1200,980]"))
        assertTrue(PagePinch.restsAtMinimum("[411.5,412]"))
        assertFalse(PagePinch.restsAtMinimum("[206,412]"))
        assertFalse(PagePinch.restsAtMinimum("[490,980]"))
        assertTrue(PagePinch.restsAtMinimum("\"[412,412]\""))
    }

    @Test
    fun anUnreadableViewportNeverCountsAsMinimum() {
        assertFalse(PagePinch.restsAtMinimum(null))
        assertFalse(PagePinch.restsAtMinimum("null"))
        assertFalse(PagePinch.restsAtMinimum(""))
        assertFalse(PagePinch.restsAtMinimum("[0,412]"))
        assertFalse(PagePinch.restsAtMinimum("[412]"))
        assertFalse(PagePinch.restsAtMinimum("{\"width\":412}"))
    }

    @Test
    fun theDocumentChangesOnANewAddressASameUrlReloadASameDocumentNavigationOrANewWebView() {
        val document = PageDocument()
        assertEquals(0L, document.saw("https://a.example/", isLoading = false))
        assertEquals(0L, document.saw("https://a.example/", isLoading = false))
        assertEquals(1L, document.saw("https://a.example/", isLoading = true))
        assertEquals(1L, document.saw("https://a.example/", isLoading = false))
        assertEquals(2L, document.saw("https://a.example/#section", isLoading = false))
        assertEquals(3L, document.saw("https://a.example/next", isLoading = false))
        assertEquals(4L, document.replaced())
        assertEquals(4L, document.saw("https://a.example/next", isLoading = false))
    }
}
