package com.ardia.phone

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.graphics.toArgb
import com.ardia.design.FrostedStyle
import expo.modules.kotlin.AppContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GlassPlateDrawTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    private var pulled = 0

    @Before
    fun countPulls() {
        GlassShaders.reset()
        GlassReadability.onPulled = { pulled += 1 }
    }

    @After
    fun restore() {
        GlassShaders.reset()
        GlassReadability.onPulled = null
    }

    private fun glass(dark: Boolean, tint: Int?) = GlassView(activity, appContext).apply {
        shape = "rounded"
        glassCornerRadius = 12f
        this.dark = dark
        this.tint = tint
        layout(0, 0, 120, 48)
    }

    private fun drawnOver(view: GlassView, backdrop: Int): Bitmap = Bitmap.createBitmap(120, 48, Bitmap.Config.ARGB_8888).apply {
        eraseColor(backdrop)
        view.draw(Canvas(this))
    }

    @Test
    fun aGlassWithNothingToBlurStillReadsOverAWhitePageAndCountsThePullOnce() {
        for (tint in listOf(null, 0x26B25B6B, 0x80FFFFFF.toInt())) {
            pulled = 0
            val view = glass(dark = true, tint = tint)
            val first = drawnOver(view, 0xFFFFFFFF.toInt())
            drawnOver(view, 0xFFFFFFFF.toInt())
            val plate = first.getPixel(60, 24)
            val red = ((plate shr 16) and 0xFF) / 255.0
            val green = ((plate shr 8) and 0xFF) / 255.0
            val blue = (plate and 0xFF) / 255.0
            assertTrue("white ink on tint $tint reads ${GlassReadability.reads(GlassReadability.lightInk, red, green, blue)}", GlassReadability.reads(GlassReadability.lightInk, red, green, blue) >= GlassReadability.READABLE_CONTRAST)
            assertEquals("the pull is counted once, not on every draw", 1, pulled)
        }
    }

    @Test
    fun aLightGlassOverABlackPageReads() {
        val view = glass(dark = false, tint = 0x26B25B6B)
        val plate = drawnOver(view, 0xFF000000.toInt()).getPixel(60, 24)
        val red = ((plate shr 16) and 0xFF) / 255.0
        val green = ((plate shr 8) and 0xFF) / 255.0
        val blue = (plate and 0xFF) / 255.0
        assertTrue(GlassReadability.reads(GlassReadability.darkInk, red, green, blue) >= GlassReadability.READABLE_CONTRAST)
    }

    @Test
    fun aPullWatchCountsEachTimeAPlateStartsNeedingIt() {
        val watch = PullWatch()
        watch.note(false)
        watch.note(true)
        watch.note(true)
        watch.note(false)
        watch.note(true)
        assertEquals(2, pulled)
    }

    @Test
    fun aShadeChangeEasesTheBoundOverOneFifthOfASecond() {
        var now = 1_000L
        val ease = ToneEase { now }
        assertEquals(GlassReadability.steady(false) to false, ease.limit(false))
        val (first, easing) = ease.limit(true)
        assertTrue(easing)
        assertTrue("the new dark plate starts just under the ceiling", first.floor > GlassReadability.ceiling - 0.01)
        now += GlassReadability.TONE_EASE_MS
        assertEquals(GlassReadability.steady(true) to false, ease.limit(true))
    }
}
