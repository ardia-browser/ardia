package com.ardia.phone

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.widget.FrameLayout
import com.ardia.design.Frosting
import expo.modules.kotlin.AppContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LookOffTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    @After
    fun reset() {
        LookSwitch.set(activity, off = false, lab = true)
        LookSwitch.forgetForTests()
    }

    private val sourceName = "deck-test-${System.nanoTime()}"

    private fun scene(): Triple<FrostSourceView, FrostView, DeckBackdropView> {
        val root = FrameLayout(activity)
        activity.setContentView(root)
        val source = FrostSourceView(activity, appContext).apply { sourceId = sourceName }
        val deck = DeckBackdropView(activity, appContext)
        source.addView(deck)
        val frost = FrostView(activity, appContext).apply { this.source = sourceName }
        root.addView(source, FrameLayout.LayoutParams(1080, 2400))
        root.addView(frost, FrameLayout.LayoutParams(300, 120))
        root.measure(1080, 2400)
        root.layout(0, 0, 1080, 2400)
        val canvas = Canvas(Bitmap.createBitmap(10, 10, Bitmap.Config.ARGB_8888))
        frost.drawSafely(canvas)
        deck.drawSafely(canvas)
        return Triple(source, frost, deck)
    }

    private fun assertNothingLeftBehind(why: String, scene: Triple<FrostSourceView, FrostView, DeckBackdropView>) {
        val (source, frost, deck) = scene
        assertFalse("$why: the source does not record", source.isRecording)
        assertFalse("$why: the frost holds no layer", frost.holdsLayer)
        assertFalse("$why: the backdrop does not animate", deck.isAnimating)
    }

    @Test
    fun withTheLookOffNothingRecordsBlursOrAnimates() {
        LookSwitch.set(activity, off = true, lab = true)
        val made = scene()
        assertFalse(made.second.canBlur())
        assertFalse(FrostSources.anyFrostCanBlur(sourceName))
        assertNothingLeftBehind("look off", made)
    }

    @Test
    fun withReduceTransparencyNoFrostWantsTheSourceSoItIsNotRecorded() {
        val made = scene()
        val (_, frost, deck) = made
        assertFalse("drawn on a software canvas it falls back, so it does not keep the source recording", frost.wantsSource())
        val fresh = FrostView(activity, appContext).apply { source = sourceName }
        (frost.parent as android.view.ViewGroup).addView(fresh)
        assertEquals("a frost that has not drawn yet wants its source", Frosting.isBlurSupported, FrostSources.anyFrostCanBlur(sourceName))
        frost.reduceTransparency = true
        fresh.reduceTransparency = true
        deck.reduceTransparency = true
        assertFalse(FrostSources.anyFrostCanBlur(sourceName))
        assertNothingLeftBehind("reduce transparency", made)
    }

    @Test
    fun aSourceAsksWhetherItHoldsAPageOnlyWhenABlurringFrostNeedsIt() {
        val (source, _, _) = scene()
        source.viewTreeObserver.dispatchOnGlobalLayout()
        assertFalse(source.holdsPage)
    }
}
