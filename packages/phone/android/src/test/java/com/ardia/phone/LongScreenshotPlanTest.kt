package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LongScreenshotPlanTest {
    private val viewport = 2000

    @Test
    fun aPageHeightTheWebViewReportsIsClampedToOneToTwentyScreens() {
        assertEquals(5_500, LongScreenshotPlan.pageHeight(5_500.7, viewport))
        assertEquals(viewport, LongScreenshotPlan.pageHeight(1_200.0, viewport))
        assertEquals(viewport * LongScreenshotPlan.MAX_SCREENS, LongScreenshotPlan.pageHeight(9_000_000.0, viewport))
        for (hostile in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, -1.0, 0.0, -1e300)) {
            assertEquals("$hostile", viewport, LongScreenshotPlan.pageHeight(hostile, viewport))
        }
        assertEquals(viewport * LongScreenshotPlan.MAX_SCREENS, LongScreenshotPlan.pageHeight(1e300, viewport))
        assertEquals(0, LongScreenshotPlan.pageHeight(5_000.0, 0))
    }

    @Test
    fun theBudgetFollowsFreeMemoryBetweenItsFloorAndCeiling() {
        assertEquals(LongScreenshotPlan.MIN_BUDGET_BYTES, LongScreenshotPlan.budget(0))
        assertEquals(LongScreenshotPlan.MIN_BUDGET_BYTES, LongScreenshotPlan.budget(-5))
        assertEquals(64L * 1024 * 1024, LongScreenshotPlan.budget(512L * 1024 * 1024))
        assertEquals(LongScreenshotPlan.MAX_BUDGET_BYTES, LongScreenshotPlan.budget(16L * 1024 * 1024 * 1024))
    }

    @Test
    fun aShortPageKeepsFullSizeAndATallOneScalesIntoTheBudget() {
        val small = LongScreenshotPlan.output(1080, 6_000, LongScreenshotPlan.MAX_BUDGET_BYTES)!!
        assertEquals(LongScreenshotPlan.Output(1080, 6_000, 1.0), small)
        val tall = LongScreenshotPlan.output(1080, 40_000, LongScreenshotPlan.MAX_BUDGET_BYTES)!!
        assertTrue(tall.scale < 1.0)
        assertTrue(tall.width.toLong() * tall.height * 4 <= LongScreenshotPlan.MAX_BUDGET_BYTES)
        assertEquals(tall.width.toDouble() / 1080, tall.scale, 1e-9)
        assertNull(LongScreenshotPlan.output(0, 6_000, LongScreenshotPlan.MAX_BUDGET_BYTES))
        assertNull(LongScreenshotPlan.output(1080, 0, LongScreenshotPlan.MAX_BUDGET_BYTES))
    }

    @Test
    fun stepsOverlapAQuarterScreenAndTwentyScreensFitTheStepLimit() {
        assertEquals(1_500, LongScreenshotPlan.stride(viewport))
        val pageHeight = viewport * LongScreenshotPlan.MAX_SCREENS
        assertTrue((LongScreenshotPlan.maxSteps(pageHeight, viewport) - 3) * LongScreenshotPlan.stride(viewport) + viewport >= pageHeight)
        assertEquals(3, LongScreenshotPlan.maxSteps(viewport, viewport))
    }

    private val pageWidth = 40

    private fun page(rows: Int): IntArray = IntArray(pageWidth * rows) { index ->
        val row = index / pageWidth
        val column = index % pageWidth
        if (row % 7 == 0) 0xFFFFFFFF.toInt() else (0xFF000000.toInt() or (((row * 53) and 0xFF) shl 16) or (((row * 97 + column) and 0xFF) shl 8) or ((row * 29 + column * 3) and 0xFF))
    }

    private fun window(source: IntArray, top: Int, rows: Int): IntArray = source.copyOfRange(top * pageWidth, (top + rows) * pageWidth)

    @Test
    fun theMoveBetweenTwoStepsComesFromThePixelsWhateverTheScrollPositionSays() {
        val source = page(800)
        val before = window(source, 0, 200)
        for (said in listOf(40, 140, 155, 170, 280)) assertEquals("scroll said $said", 155, LongScreenshotPlan.offset(before, 200, window(source, 155, 200), 200, pageWidth, said))
        assertEquals(60, LongScreenshotPlan.offset(before, 200, window(source, 60, 200), 200, pageWidth, 280))
    }

    @Test
    fun aBannerThatOnlyTheFirstStepShowsDoesNotThrowTheMatchOff() {
        val source = page(800)
        val before = window(source, 0, 200)
        for (row in 185 until 200) for (column in 0 until pageWidth) before[row * pageWidth + column] = 0xFF2266FF.toInt()
        val after = window(source, 120, 200)
        assertEquals(120, LongScreenshotPlan.offset(before, 200, after, 200, pageWidth, 130))
    }

    @Test
    fun aPageThatDidNotMoveMatchesNoMove() {
        val source = page(800)
        assertEquals(0, LongScreenshotPlan.offset(window(source, 0, 200), 200, window(source, 0, 200), 200, pageWidth, 150))
    }

    @Test
    fun aBlankOverlapKeepsTheScrollPositionAndNoMatchOrBrokenInputGivesNothing() {
        val blank = IntArray(pageWidth * 200) { 0xFFFFFFFF.toInt() }
        assertEquals(140, LongScreenshotPlan.offset(blank, 200, blank, 200, pageWidth, 140))
        assertNull(LongScreenshotPlan.offset(blank, 200, blank, 200, pageWidth, 300))
        val source = page(800)
        assertNull("a jump past the screen", LongScreenshotPlan.offset(window(source, 0, 200), 200, window(source, 500, 200), 200, pageWidth, 150))
        assertNull(LongScreenshotPlan.offset(window(source, 0, 200), 200, IntArray(10), 200, pageWidth, 150))
        assertNull(LongScreenshotPlan.offset(window(source, 0, 200), 200, window(source, 150, 200), 200, 0, 150))
    }

    @Test
    fun aTranslucentBackdropHiddenAfterTheFirstStepLeavesNoMatchWithTheFirstPicture() {
        val source = page(800)
        val tinted = window(source, 0, 200).map { pixel -> (pixel and 0xFF000000.toInt()) or ((pixel and 0xFEFEFE) shr 1) }.toIntArray()
        assertNull(LongScreenshotPlan.offset(tinted, 200, window(source, 150, 200), 200, pageWidth, 150))
        assertEquals("the first step drawn again once the backdrop is hidden matches", 150, LongScreenshotPlan.offset(window(source, 0, 200), 200, window(source, 150, 200), 200, pageWidth, 150))
    }

    @Test
    fun aCaptureIsCompleteOnlyWhenItCoversThePageOrReachedItsBottom() {
        assertEquals(LongScreenshotPlan.Ending.Complete, LongScreenshotPlan.ending(5_500, 5_500, viewport, atBottom = false))
        assertEquals(LongScreenshotPlan.Ending.Complete, LongScreenshotPlan.ending(5_500 - LongScreenshotPlan.COMPLETE_TOLERANCE, 5_500, viewport, atBottom = false))
        assertEquals("steps ran out", LongScreenshotPlan.Ending.Stopped, LongScreenshotPlan.ending(3_000, 5_500, viewport, atBottom = false))
        assertEquals("the page ended sooner than it said", LongScreenshotPlan.Ending.Complete, LongScreenshotPlan.ending(3_000, 5_500, viewport, atBottom = true))
        assertEquals("a taller page that never moved", LongScreenshotPlan.Ending.Failed, LongScreenshotPlan.ending(viewport, 5_500, viewport, atBottom = true))
        assertEquals(LongScreenshotPlan.Ending.Failed, LongScreenshotPlan.ending(viewport, 5_500, viewport, atBottom = false))
        assertEquals("a page one screen tall", LongScreenshotPlan.Ending.Complete, LongScreenshotPlan.ending(viewport, viewport, viewport, atBottom = false))
    }

    @Test
    fun theViewportPictureAndBothPixelArraysComeOutOfTheBudgetAndTooBigAViewportIsRefused() {
        assertEquals(1080L * 2400 * 4 * 3, LongScreenshotPlan.workingBytes(1080, 2400))
        val plenty = 16L * 1024 * 1024 * 1024
        assertEquals(LongScreenshotPlan.MAX_BUDGET_BYTES - LongScreenshotPlan.workingBytes(1080, 2400), LongScreenshotPlan.outputBudget(plenty, 1080, 2400))
        assertNull("4000 x 4000 needs more than the whole cap for its working copies", LongScreenshotPlan.outputBudget(plenty, 4_000, 4_000))
        assertNull(LongScreenshotPlan.outputBudget(0, 2_000, 2_000))
        for (available in listOf(0L, 512L * 1024 * 1024, plenty)) {
            val output = LongScreenshotPlan.outputBudget(available, 1080, 2400) ?: continue
            assertTrue(output + LongScreenshotPlan.workingBytes(1080, 2400) <= LongScreenshotPlan.budget(available))
        }
        assertEquals(0L, LongScreenshotPlan.workingBytes(-1, 2400))
    }

    @Test
    fun theWarmPassDragsEveryBandAnEighthOfAScreenTallAcrossTheScreensBottomEdge() {
        val pageHeight = 18_604
        val viewport = 2_320
        val stops = LongScreenshotPlan.warmStops(pageHeight, viewport)
        assertEquals(pageHeight - viewport, stops.last())
        assertTrue(stops.zipWithNext().all { (a, b) -> b > a })
        val band = viewport / 8
        for (top in viewport..(pageHeight - band) step 7) {
            assertTrue("a band at $top crosses the bottom edge", (listOf(0) + stops).any { stop -> stop + viewport in top until top + band })
        }
        assertEquals(emptyList<Int>(), LongScreenshotPlan.warmStops(viewport, viewport))
        assertEquals(emptyList<Int>(), LongScreenshotPlan.warmStops(5_000, 0))
    }

    @Test
    fun theLastScreenAddsOnlyTheRowsNotYetCaptured() {
        assertEquals(LongScreenshotPlan.Slice(500, 2_000, 4_000, 5_500), LongScreenshotPlan.slice(3_500, 4_000, viewport, 5_500))
    }

    @Test
    fun aPageThatWontScrollFurtherEndsTheCapture() {
        assertNull("scroll stuck at the top", LongScreenshotPlan.slice(0, 2_000, viewport, 9_000))
        assertNull("a gap would leave blank rows", LongScreenshotPlan.slice(2_500, 2_000, viewport, 9_000))
        assertNull(LongScreenshotPlan.slice(0, 0, 0, 9_000))
        assertNull(LongScreenshotPlan.slice(-1, 0, viewport, 9_000))
    }

    @Test
    fun anOverlappingStepAddsOnlyItsNewRows() {
        assertEquals(LongScreenshotPlan.Slice(500, 1_800, 2_000, 3_300), LongScreenshotPlan.slice(1_500, 2_000, 1_800, 9_000))
    }

    @Test
    fun neighbouringSlicesMeetOnTheSameScaledRow() {
        val output = LongScreenshotPlan.output(1080, 40_000, LongScreenshotPlan.MAX_BUDGET_BYTES)!!
        val first = LongScreenshotPlan.slice(0, 0, viewport, 40_000)!!
        val second = LongScreenshotPlan.slice(1_500, first.pageBottom, viewport, 40_000)!!
        assertEquals(LongScreenshotPlan.rowIn(output, first.pageBottom), LongScreenshotPlan.rowIn(output, second.pageTop))
        assertEquals(output.height, LongScreenshotPlan.rowIn(output, 40_000))
    }

    @Test
    fun tilesCoverTheImageWithoutOverlap() {
        assertEquals(listOf(0 until 2048, 2048 until 4096, 4096 until 5000), LongScreenshotPlan.tiles(5_000))
        assertEquals(emptyList<IntRange>(), LongScreenshotPlan.tiles(0))
    }

    @Test
    fun aCropIsAlwaysInsideTheImageAndAtLeastOneRowTall() {
        assertEquals(LongScreenshotPlan.Crop(100, 4_000), LongScreenshotPlan.crop(5_000, 100.4, 3_999.6))
        assertEquals(LongScreenshotPlan.Crop(0, 5_000), LongScreenshotPlan.crop(5_000, -50.0, 9e9))
        assertEquals(LongScreenshotPlan.Crop(4_999, 5_000), LongScreenshotPlan.crop(5_000, 6_000.0, 10.0))
        assertNull(LongScreenshotPlan.crop(5_000, Double.NaN, 10.0))
        assertNull(LongScreenshotPlan.crop(5_000, 0.0, Double.POSITIVE_INFINITY))
        assertNull(LongScreenshotPlan.crop(0, 0.0, 1.0))
    }
}
