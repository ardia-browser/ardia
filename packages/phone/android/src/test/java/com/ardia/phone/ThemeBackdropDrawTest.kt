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
class ThemeBackdropDrawTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    private val theme = ThemeLook(
        stops = listOf(
            ThemeStop(ThemeColor(0.9, 0.4, 0.5), 0.2, 0.3),
            ThemeStop(ThemeColor(0.2, 0.5, 0.9), 0.7, 0.6),
            ThemeStop(ThemeColor(0.4, 0.9, 0.3, 0.8), 0.5, 0.9),
        ),
        intensity = 0.4,
        grain = 0.0,
        texture = ThemeTexture.Tweed,
        translucency = 0.6,
        angle = 200.0,
    )

    private fun backdrop(width: Int, height: Int, dark: Boolean, look: ThemeLook?, themed: Boolean = true) = ProfileBackdropView(activity, appContext).apply {
        color = "#B04A7A"
        themeColors = listOf("#E66680", "#3380E6")
        this.dark = dark
        this.themed = themed
        themeLook = look
        layout(0, 0, width, height)
    }

    private fun deck(width: Int, height: Int, dark: Boolean, look: ThemeLook?, still: Boolean = true) = DeckBackdropView(activity, appContext).apply {
        color = "#B04A7A"
        themeColors = listOf("#E66680", "#3380E6")
        this.dark = dark
        reduceMotion = still
        themeLook = look
        layout(0, 0, width, height)
    }

    private fun drawn(view: LookView): Bitmap {
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.drawSafely(Canvas(bitmap))
        return bitmap
    }

    private fun painted(view: DeckBackdropView, mode: LookSwitch.BackdropDraw): Bitmap {
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        assertTrue(view.paint(Canvas(bitmap), mode, at = 0L))
        return bitmap
    }

    private fun expected(look: ThemeLook, dark: Boolean, x: Double, y: Double, width: Double, height: Double): IntArray {
        val area = look.area(x, y, width, height)
        val under = Color.red(look.underColor(dark)) / 255.0
        val alpha = ((look.layerAlpha * 255).toInt()) / 255.0
        return IntArray(3) { (255 * (alpha * area[it].coerceIn(0.0, 1.0) + (1 - alpha) * under)).toInt() }
    }

    private fun assertNear(label: String, want: IntArray, pixel: Int, slack: Int = 4) {
        val got = intArrayOf(Color.red(pixel), Color.green(pixel), Color.blue(pixel))
        for (i in 0 until 3) assertTrue("$label: want ${want.toList()} got ${got.toList()}", abs(want[i] - got[i]) <= slack)
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

    private fun meanLightness(bitmap: Bitmap): Double {
        var total = 0L
        var count = 0L
        for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
            val p = bitmap.getPixel(x, y)
            total += Color.red(p) + Color.green(p) + Color.blue(p)
            count += 3
        }
        return total.toDouble() / count
    }

    @Test
    fun aThemedBackdropDrawsTheMacCompositeInBothModes() {
        for (dark in listOf(false, true)) {
            val bitmap = drawn(backdrop(200, 400, dark, theme))
            for ((x, y) in listOf(10 to 10, 100 to 200, 190 to 390, 150 to 50)) {
                assertNear("dark $dark at $x,$y", expected(theme, dark, x + 0.5, y + 0.5, 200.0, 400.0), bitmap.getPixel(x, y))
            }
        }
    }

    @Test
    fun theTextureDarkensTheCompositeByItsNoise() {
        val smooth = meanLightness(drawn(backdrop(128, 128, false, theme)))
        val textured = meanLightness(drawn(backdrop(128, 128, false, theme.copy(grain = 1.0, texture = ThemeTexture.Sand))))
        val drop = smooth - textured
        assertTrue("sand at full noise darkens by $drop", drop > 1.0 && drop < 20.0)
    }

    @Test
    fun withoutAThemeLookOrUnthemedTheBackdropIsAsBefore() {
        val before = drawn(backdrop(120, 240, false, null))
        assertEquals(0.0, meanDifference(before, drawn(backdrop(120, 240, false, null).apply { themeLook = theme; themeLook = null })), 0.0)
        val unthemed = drawn(backdrop(120, 240, false, null, themed = false))
        assertEquals(0.0, meanDifference(unthemed, drawn(backdrop(120, 240, false, theme, themed = false))), 0.0)
        assertTrue(meanDifference(before, drawn(backdrop(120, 240, false, theme))) > 5.0)
    }

    @Test
    fun theDeckDrawsTheThemeAndItsSmallImageMatchesTheFullDrawing() {
        for (dark in listOf(false, true)) {
            val full = painted(deck(270, 600, dark, theme), LookSwitch.BackdropDraw.Full)
            val small = painted(deck(270, 600, dark, theme), LookSwitch.BackdropDraw.Small)
            val difference = meanDifference(full, small)
            assertTrue("mean difference $difference, dark $dark", difference < 4.0)
            assertNear("deck centre, dark $dark", expected(theme, dark, 135.0, 300.0, 270.0, 600.0), full.getPixel(135, 300), slack = 6)
        }
    }

    @Test
    fun aThemedDeckIsOnlyTheCompositeWithNoMovingBlobs() {
        val view = deck(270, 600, false, theme, still = false)
        assertTrue(!view.isAnimating)
        val moving = painted(view, LookSwitch.BackdropDraw.Full)
        val later = Bitmap.createBitmap(270, 600, Bitmap.Config.ARGB_8888)
        assertTrue(view.paint(Canvas(later), LookSwitch.BackdropDraw.Full, at = 20_000L))
        assertEquals(0.0, meanDifference(moving, later), 0.0)
        val blobless = painted(deck(270, 600, false, theme).apply { reduceTransparency = true }, LookSwitch.BackdropDraw.Full)
        assertEquals(0.0, meanDifference(moving, blobless), 0.0)
        val unthemed = deck(270, 600, false, null, still = false)
        assertTrue(meanDifference(painted(unthemed, LookSwitch.BackdropDraw.Full), painted(deck(270, 600, false, null).apply { reduceTransparency = true }, LookSwitch.BackdropDraw.Full)) > 0.5)
    }

    @Test
    fun aDeckRepaintsWhenItsThemeLookChanges() {
        val view = deck(270, 600, false, null)
        val plain = painted(view, LookSwitch.BackdropDraw.Small)
        view.themeLook = theme
        val themed = painted(view, LookSwitch.BackdropDraw.Small)
        assertTrue(meanDifference(plain, themed) > 5.0)
        view.themeLook = null
        assertEquals(0.0, meanDifference(plain, painted(view, LookSwitch.BackdropDraw.Small)), 1.0)
    }

    @Test
    fun theTexturePaintIsMadeOncePerTextureDensityAndAlpha() {
        ThemeTextures.forgetCaches()
        val first = ThemeTextures.paint(ThemeTexture.Denim, 3f, 0.3f)
        assertTrue(first === ThemeTextures.paint(ThemeTexture.Denim, 3f, 0.3f))
        ThemeTextures.paint(ThemeTexture.Denim, 2f, 0.3f)
        assertEquals(2, ThemeTextures.paintCount)
        LookPaint.forgetCaches()
        assertEquals(0, ThemeTextures.paintCount)
    }
}
