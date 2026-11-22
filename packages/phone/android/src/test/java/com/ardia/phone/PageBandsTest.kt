package com.ardia.phone

import android.graphics.Bitmap
import android.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PageBandsTest {
    @Test
    fun thePageSitsBetweenTheBandsTheBarsCover() {
        assertEquals(PageBands.Frame(126, 225), PageBands.frame(2400, 126, 225))
        assertTrue(PageBands.frame(2400, 0, 0).isEmpty)
        assertEquals("a negative inset is none", PageBands.Frame(0, 0), PageBands.frame(2400, -10, -1))
    }

    @Test
    fun bandsNeverSqueezeThePageBelowAQuarterOfTheView() {
        val squeezed = PageBands.frame(400, 300, 300)
        assertTrue(squeezed.top + squeezed.bottom <= 300)
        assertEquals("they shrink in proportion", squeezed.top, squeezed.bottom)
    }

    @Test
    fun theToneIsSampledAtTheWebViewsOwnEdgeWhenItStopsAtTheBar() {
        assertEquals("iPhone's tone insets, the bar's 75 dp: the WebView already ends there", 0 to 0, PageBands.toneOffsets(0 to 225, PageBands.Frame(126, 225)))
        assertEquals("no bands: as before", 0 to 225, PageBands.toneOffsets(0 to 225, PageBands.Frame(0, 0)))
        assertEquals("a tone inset deeper than the band keeps the rest", 10 to 30, PageBands.toneOffsets(136 to 255, PageBands.Frame(126, 225)))
    }

    @Test
    fun aBandWithoutAToneShowsTheSurfaceThePageShowsBeforeItDraws() {
        assertEquals(Color.RED, PageBands.colour(Color.RED, Color.WHITE))
        assertEquals(Color.WHITE, PageBands.colour(null, Color.WHITE))
        assertNull(PageBands.colour(null, null))
    }

    @Test
    fun theSnapshotIsTheWholeViewWithItsBandsSoACardMatchesThePage() {
        val page = Bitmap.createBitmap(270, 512, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.GREEN) }
        val bands = PageBands.Frame(126, 225)
        val composed = PageBands.compose(page, 1080, 2400, bands, Color.RED, Color.BLUE)
        assertEquals(270, composed.width)
        assertEquals("the view's height at the picture's scale", 600, composed.height)
        assertEquals(Color.RED, composed.getPixel(135, 10))
        assertEquals(Color.GREEN, composed.getPixel(135, 300))
        assertEquals(Color.BLUE, composed.getPixel(135, 590))
        val layout = PageBands.scaled(270, 512, 1080, 2400, bands)
        assertEquals(32, layout.pageTop)
        assertEquals(512, layout.pageHeight)
    }

    @Test
    fun withoutBandsTheSnapshotIsUntouched() {
        val page = Bitmap.createBitmap(10, 10, Bitmap.Config.ARGB_8888)
        assertSame(page, PageBands.compose(page, 1080, 2400, PageBands.Frame(0, 0), Color.RED, Color.BLUE))
    }

    @Test
    fun summaryPlacementClearsTheFloatingBarWhenBottomBandIsTransparent() {
        val transparentBar = PageBands.summaryPlacement(
            height = 2400,
            density = 3f,
            bands = PageBands.Frame(126, 0),
            toneBottomPx = 0,
            summaryBottomPx = 225,
            marginDp = 12f,
            heightShare = 0.45f,
            minimumHeightDp = 160f,
        )
        val bandedBar = PageBands.summaryPlacement(
            height = 2400,
            density = 3f,
            bands = PageBands.Frame(126, 225),
            toneBottomPx = 225,
            summaryBottomPx = 0,
            marginDp = 12f,
            heightShare = 0.45f,
            minimumHeightDp = 160f,
        )
        assertEquals(261, transparentBar.bottomPx)
        assertEquals(bandedBar, transparentBar)
    }
}
