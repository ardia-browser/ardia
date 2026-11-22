package com.ardia.phone

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View.MeasureSpec
import expo.modules.kotlin.AppContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LookDrawSafetyTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    private class Exploding(activity: Activity, appContext: AppContext) : LookView(activity, appContext) {
        var attempts = 0
        var fallbacks = 0

        override fun fallbackColor(): Int {
            fallbacks += 1
            return android.graphics.Color.RED
        }

        override fun drawLook(canvas: Canvas) {
            attempts += 1
            canvas.save()
            throw IllegalArgumentException("ending radius must be > 0")
        }
    }

    private fun sized(view: android.view.View, width: Int, height: Int) {
        view.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
        view.layout(0, 0, width, height)
    }

    @Test
    fun aLookViewThatCannotDrawFallsBackToAFlatColourInsteadOfCrashing() {
        val view = Exploding(activity, appContext)
        sized(view, 8, 8)
        val bitmap = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val saves = canvas.saveCount
        view.drawSafely(canvas)
        assertEquals(1, view.attempts)
        assertEquals("the canvas is restored", saves, canvas.saveCount)
        assertEquals("it fell back to a flat colour", 1, view.fallbacks)
        view.drawSafely(canvas)
        assertEquals("it keeps trying on later frames", 2, view.attempts)
    }

    @Test
    fun nothingIsDrawnBeforeTheViewHasASize() {
        val view = Exploding(activity, appContext)
        view.drawSafely(Canvas(Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)))
        assertEquals(0, view.attempts)
    }

    @Test
    fun theDeckBackdropDrawsAtAnySizeWithoutThrowing() {
        for ((width, height) in listOf(1 to 1, 1 to 400, 400 to 1, 300 to 600)) {
            val deck = DeckBackdropView(activity, appContext).apply { color = "incognito"; dark = false }
            sized(deck, width, height)
            deck.drawSafely(Canvas(Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)))
        }
        assertTrue(LookRules.blobRadius(0f, 0f) > 0f)
    }
}
