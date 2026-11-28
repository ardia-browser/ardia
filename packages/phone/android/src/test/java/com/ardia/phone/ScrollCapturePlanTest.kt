package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScrollCapturePlanTest {
    private val viewport = 2000

    @Test
    fun aPageHeightTheWebViewReportsIsAtLeastOneScreenAndFinite() {
        assertEquals(5_500, ScrollCapturePlan.pageHeight(5_500.7, viewport))
        assertEquals(viewport, ScrollCapturePlan.pageHeight(1_200.0, viewport))
        for (hostile in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, -1.0, 0.0, -1e300)) {
            assertEquals("$hostile", viewport, ScrollCapturePlan.pageHeight(hostile, viewport))
        }
        assertEquals(Int.MAX_VALUE / 4, ScrollCapturePlan.pageHeight(1e300, viewport))
        assertEquals(0, ScrollCapturePlan.pageHeight(5_000.0, 0))
    }

    @Test
    fun theStartTileIsWhatWasOnScreen() {
        val tile = ScrollCapturePlan.tile(start = 3_000, areaTop = 0, areaBottom = viewport, landed = 3_000, viewport = viewport, pageHeight = 10_000)!!
        assertEquals(ScrollCapturePlan.Tile(sourceTop = 0, rows = viewport, top = 0, bottom = viewport), tile)
        assertEquals(3_000, ScrollCapturePlan.scrollFor(3_000, 0, viewport, viewport, 10_000))
    }

    @Test
    fun aTileInsideTheScreenYouTookIsDrawnWithoutScrolling() {
        assertEquals(3_000, ScrollCapturePlan.scrollFor(3_000, 1_000, 2_000, viewport, 10_000))
        assertEquals(ScrollCapturePlan.Tile(sourceTop = 1_000, rows = 1_000, top = 1_000, bottom = 2_000), ScrollCapturePlan.tile(3_000, 1_000, 2_000, landed = 3_000, viewport = viewport, pageHeight = 10_000))
    }

    @Test
    fun aTileBelowScrollsItsTopToTheViewportsTop() {
        assertEquals(5_000, ScrollCapturePlan.scrollFor(3_000, 2_000, 4_000, viewport, 10_000))
        val tile = ScrollCapturePlan.tile(3_000, 2_000, 4_000, landed = 5_000, viewport = viewport, pageHeight = 10_000)!!
        assertEquals(ScrollCapturePlan.Tile(0, 2_000, 2_000, 4_000), tile)
    }

    @Test
    fun theLastTileStopsAtThePagesEndAndDrawsFromWhereTheScrollStopped() {
        assertEquals(8_000, ScrollCapturePlan.scrollFor(3_000, 6_000, 8_000, viewport, 10_000))
        val tile = ScrollCapturePlan.tile(3_000, 6_000, 8_000, landed = 8_000, viewport = viewport, pageHeight = 10_000)!!
        assertEquals(ScrollCapturePlan.Tile(sourceTop = 1_000, rows = 1_000, top = 6_000, bottom = 7_000), tile)
        assertNull(ScrollCapturePlan.tile(3_000, 8_000, 10_000, landed = 8_000, viewport = viewport, pageHeight = 10_000))
    }

    @Test
    fun aTileAboveTheStartReachesThePagesTopAndNothingAboveIt() {
        assertEquals(1_000, ScrollCapturePlan.scrollFor(3_000, -2_000, 0, viewport, 10_000))
        assertEquals(ScrollCapturePlan.Tile(0, 2_000, -2_000, 0), ScrollCapturePlan.tile(3_000, -2_000, 0, landed = 1_000, viewport = viewport, pageHeight = 10_000))
        assertEquals(0, ScrollCapturePlan.scrollFor(3_000, -4_000, -2_000, viewport, 10_000))
        assertEquals(ScrollCapturePlan.Tile(0, 1_000, -3_000, -2_000), ScrollCapturePlan.tile(3_000, -4_000, -2_000, landed = 0, viewport = viewport, pageHeight = 10_000))
        assertNull(ScrollCapturePlan.tile(3_000, -6_000, -4_000, landed = 0, viewport = viewport, pageHeight = 10_000))
    }

    @Test
    fun aScrollThatLandedShortGivesOnlyTheRowsOnScreen() {
        val tile = ScrollCapturePlan.tile(0, 2_000, 4_000, landed = 1_500, viewport = viewport, pageHeight = 10_000)!!
        assertEquals(ScrollCapturePlan.Tile(sourceTop = 500, rows = 1_500, top = 2_000, bottom = 3_500), tile)
    }

    @Test
    fun aPageShorterThanItsScreenGivesOnlyItsOwnRows() {
        assertEquals(0, ScrollCapturePlan.scrollFor(0, 2_000, 4_000, viewport, viewport))
        assertNull(ScrollCapturePlan.tile(0, 2_000, 4_000, landed = 0, viewport = viewport, pageHeight = viewport))
        assertNull(ScrollCapturePlan.tile(0, 0, 0, landed = 0, viewport = viewport, pageHeight = viewport))
        assertNull(ScrollCapturePlan.tile(0, 0, 2_000, landed = 0, viewport = 0, pageHeight = viewport))
    }

    @Test
    fun hugeOffsetsNeverOverflow() {
        assertEquals(8_000, ScrollCapturePlan.scrollFor(Int.MAX_VALUE, Int.MAX_VALUE, Int.MAX_VALUE, viewport, 10_000))
        assertEquals(0, ScrollCapturePlan.scrollFor(Int.MIN_VALUE, Int.MIN_VALUE, Int.MIN_VALUE + 1, viewport, 10_000))
    }

    @Test
    fun fixedElementsShowOnlyInTilesInsideTheScreenYouTook() {
        assertTrue(ScrollCapturePlan.withinStart(0, 1_000, viewport))
        assertTrue(ScrollCapturePlan.withinStart(1_000, 2_000, viewport))
        assertFalse(ScrollCapturePlan.withinStart(1_000, 2_001, viewport))
        assertFalse(ScrollCapturePlan.withinStart(2_000, 4_000, viewport))
        assertFalse(ScrollCapturePlan.withinStart(-1_000, 0, viewport))
        assertFalse(ScrollCapturePlan.withinStart(500, 500, viewport))
    }

    @Test
    fun aLandingIsTrustedWhenThePagesCssScrollAndTheViewsPixelsAgree() {
        assertTrue(ScrollCapturePlan.landedWhereAsked(762, 2.625, 2_000))
        assertFalse(ScrollCapturePlan.landedWhereAsked(762, 2.625, 1_262))
        for (hostile in listOf(Double.NaN, 0.0, -1.0, Double.POSITIVE_INFINITY)) assertFalse("$hostile", ScrollCapturePlan.landedWhereAsked(762, hostile, 2_000))
    }

    @Test
    fun scrollsAreGivenToThePageInCssPixels() {
        assertEquals("1000.000", ScrollCapturePlan.cssPixels(2_000, 2.0))
        assertEquals("2000.000", ScrollCapturePlan.cssPixels(2_000, Double.NaN))
        assertEquals("0.000", ScrollCapturePlan.cssPixels(-5, 1.0))
    }
}
