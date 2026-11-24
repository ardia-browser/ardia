package com.ardia.phone

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import expo.modules.kotlin.AppContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DeckBackdropDrawTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    private fun deck(width: Int, height: Int, dark: Boolean) = DeckBackdropView(activity, appContext).apply {
        color = "#B04A7A"
        this.dark = dark
        reduceMotion = true
        layout(0, 0, width, height)
    }

    private fun painted(view: DeckBackdropView, mode: LookSwitch.BackdropDraw): Bitmap {
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        assertTrue(view.paint(Canvas(bitmap), mode, at = 0L))
        return bitmap
    }

    private fun meanDifference(a: Bitmap, b: Bitmap): Double {
        var total = 0L
        var count = 0L
        for (y in 0 until a.height step 3) for (x in 0 until a.width step 3) {
            val p = a.getPixel(x, y)
            val q = b.getPixel(x, y)
            total += abs(Color.red(p) - Color.red(q)) + abs(Color.green(p) - Color.green(q)) + abs(Color.blue(p) - Color.blue(q))
            count += 3
        }
        return total.toDouble() / count
    }

    @Test
    fun aFlatBackdropPaintsOnlyItsOwnBoundsEvenWhenNothingClipsIt() {
        val view = deck(100, 100, dark = false).apply { layout(20, 20, 120, 120) }
        val bitmap = Bitmap.createBitmap(300, 300, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.translate(20f, 20f)
        assertTrue(view.paint(canvas, LookSwitch.BackdropDraw.Flat, at = 0L))
        assertEquals("outside the view stays untouched", 0, Color.alpha(bitmap.getPixel(200, 200)))
        assertEquals("inside is the flat colour", 255, Color.alpha(bitmap.getPixel(70, 70)))
    }

    @Test
    fun theSceneIsDrawnAtAnEighthEachWay() {
        val view = deck(1080, 2400, dark = false)
        painted(view, LookSwitch.BackdropDraw.Small)
        assertEquals(135 to 300, view.sceneSize)
    }

    @Test
    fun theSmallImageScaledUpLooksLikeTheFullSizeDrawingInBothModes() {
        for (dark in listOf(false, true)) {
            val full = painted(deck(270, 600, dark), LookSwitch.BackdropDraw.Full)
            val small = painted(deck(270, 600, dark), LookSwitch.BackdropDraw.Small)
            val difference = meanDifference(full, small)
            assertTrue("mean difference $difference of 255 per channel, dark $dark", difference < 4.0)
        }
    }

    private fun columnSteps(bitmap: Bitmap): DoubleArray {
        val columns = DoubleArray(8)
        val counts = IntArray(8)
        for (y in bitmap.height * 5 / 6 until bitmap.height * 5 / 6 + 100) for (x in 0 until bitmap.width - 1) {
            val p = bitmap.getPixel(x, y)
            val q = bitmap.getPixel(x + 1, y)
            columns[x % 8] += (abs(Color.red(p) - Color.red(q)) + abs(Color.green(p) - Color.green(q)) + abs(Color.blue(p) - Color.blue(q))) / 3.0
            counts[x % 8] += 1
        }
        return DoubleArray(8) { columns[it] / counts[it] }
    }

    @Test
    fun theScaledUpSceneHasNoStepsOnItsEightPixelGrid() {
        for (dark in listOf(false, true)) {
            val steps = columnSteps(painted(deck(1080, 2400, dark), LookSwitch.BackdropDraw.SmallNoGrain))
            val mean = steps.average()
            assertTrue("dark $dark: steps by x mod 8 ${steps.joinToString { "%.3f".format(it) }}", steps.all { it <= mean * 1.6 + 0.01 })
        }
    }

    @Test
    fun grainOverIsTheOverlayBlendDoneWithoutReadingTheScreen() {
        fun overlay(base: Float, grain: Float, opacity: Float): Float {
            val blended = if (base < 0.5f) 2f * grain * base else 1f - 2f * (1f - grain) * (1f - base)
            return base + opacity * (blended - base)
        }
        fun over(base: Float, pixel: Int): Float {
            val alpha = Color.alpha(pixel) / 255f
            return base * (1f - alpha) + Color.red(pixel) / 255f * alpha
        }
        for ((dark, base) in listOf(false to 0.85f, true to 0.2f)) {
            for (value in listOf(64, 100, 127, 160, 191)) {
                val pixel = GrainOver.pixel(value, 0.3f, dark, base)
                assertEquals("dark $dark grain $value", overlay(base, value / 255f, 0.3f), over(base, pixel), 2f / 255f)
            }
        }
    }
}
