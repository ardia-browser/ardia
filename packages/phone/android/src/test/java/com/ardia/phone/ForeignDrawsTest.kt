package com.ardia.phone

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowSystemClock

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ForeignDrawsTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    @org.junit.Before
    fun reactFlags() {
        com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsForTests.setUp()
        SceneWork.current = SceneWork.inline
    }

    @org.junit.After
    fun backgroundScenes() {
        SceneWork.current = SceneWork.background
    }

    private val root = FrameLayout(activity)
    private val deck = DeckBackdropView(activity, appContext).apply { color = "#B04A7A" }
    private val card = FrameLayout(activity)
    private val cardText = View(activity)
    private val badge = View(activity)
    private val canvas by lazy { Canvas(Bitmap.createBitmap(root.rootView.width.coerceAtLeast(1), root.rootView.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)) }

    private fun show(more: () -> Unit = {}) {
        card.addView(cardText, FrameLayout.LayoutParams(40, 20))
        root.addView(deck, FrameLayout.LayoutParams(200, 400))
        root.addView(card, FrameLayout.LayoutParams(120, 80))
        root.addView(badge, FrameLayout.LayoutParams(20, 20))
        more()
        activity.setContentView(root)
        layoutAndDraw()
        deck.judgeTraversal()
        layoutAndDraw()
        quiet()
    }

    private fun layoutAndDraw() {
        root.measure(View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.EXACTLY))
        root.layout(0, 0, 200, 400)
        root.rootView.draw(canvas)
    }

    private fun quiet() = ShadowSystemClock.advanceBy(Duration.ofMillis(LookRules.QUIET_BEFORE_MOVING_MILLIS + 50))

    private fun frame(): Boolean = deck.judgeTraversal().also { layoutAndDraw() }

    private val under = FrameLayout(activity)
    private val field = View(activity)
    private val hiddenSheet = FrameLayout(activity)
    private val sheetField = View(activity)
    private val clearSheet = FrameLayout(activity)
    private val clearField = View(activity)
    private val away = View(activity)

    private fun showWithHiddenFields() {
        under.addView(field, FrameLayout.LayoutParams(160, 40))
        hiddenSheet.addView(sheetField, FrameLayout.LayoutParams(160, 40))
        hiddenSheet.visibility = View.INVISIBLE
        clearSheet.addView(clearField, FrameLayout.LayoutParams(160, 40))
        clearSheet.alpha = 0f
        away.translationX = 1000f
        show {
            root.addView(under, 0, FrameLayout.LayoutParams(200, 400))
            root.addView(hiddenSheet, FrameLayout.LayoutParams(200, 100))
            root.addView(clearSheet, FrameLayout.LayoutParams(200, 100))
            root.addView(away, FrameLayout.LayoutParams(40, 40))
        }
    }

    private fun blinkAll() {
        field.invalidate()
        sheetField.invalidate()
        clearField.invalidate()
        away.invalidate()
    }

    @Test
    fun aCaretBlinkingWhereNobodyCanSeeItNeitherStopsTheBlobsNorTaintsASample() {
        showWithHiddenFields()
        deck.advanceBlobs()
        assertFalse(frame())
        val before = LookActivity.foreignTraversals
        repeat(6) {
            quiet()
            blinkAll()
            assertFalse("a field under the deck, in a hidden sheet, at zero alpha or off screen is nobody's frame to see", frame())
        }
        assertEquals(before, LookActivity.foreignTraversals)
        deck.advanceBlobs()
        blinkAll()
        assertFalse("a tick in the same frame as the hidden blinks is still the backdrop's own", frame())
        deck.advanceBlobs()
        assertFalse("the blobs keep moving: no quiet second was needed", deck.heldStill)
    }

    @Test
    fun theSameBlinkOnScreenOverTheDeckStillCounts() {
        showWithHiddenFields()
        deck.advanceBlobs()
        assertFalse(frame())
        quiet()
        hiddenSheet.visibility = View.VISIBLE
        frame()
        quiet()
        deck.advanceBlobs()
        sheetField.invalidate()
        assertTrue("a field the user can see redrawing over the deck is foreign", frame())
    }

    @Test
    fun aBusyDeckIsJudgedFromItsFirstVisibleChangeWithoutWalkingEveryCard() {
        val many = FrameLayout(activity)
        repeat(26) {
            val card = FrameLayout(activity)
            repeat(10) { card.addView(View(activity), FrameLayout.LayoutParams(20, 20)) }
            many.addView(card, FrameLayout.LayoutParams(180, 60))
        }
        show { root.addView(many, FrameLayout.LayoutParams(200, 400)) }
        var asked = 0
        val draws = ForeignDraws { asked += 1; true }
        assertSame("every card redrawing while the deck scrolls", many.getChildAt(0).let { it as FrameLayout }.getChildAt(0), draws.first(many, emptyList(), deck))
        assertTrue("it stops at the first one it finds: $asked of 287 views asked", asked < 10)
    }

    @Test
    fun aTickOnItsOwnIsTheBackdropsFrame() {
        show()
        val before = LookActivity.foreignTraversals
        deck.advanceBlobs()
        assertTrue("the first tick holds the resting cards on layers", deck.holdsRestingLayers)
        assertFalse("the backdrop's redraw and the layers it just made are its own", frame())
        quiet()
        deck.advanceBlobs()
        assertFalse(frame())
        assertEquals(before, LookActivity.foreignTraversals)
    }

    @Test
    fun aViewRedrawnInTheSameFrameAsATickIsForeign() {
        show()
        deck.advanceBlobs()
        assertFalse(frame())
        quiet()
        deck.advanceBlobs()
        cardText.invalidate()
        val before = LookActivity.foreignTraversals
        assertTrue("a pending tick no longer claims a frame something else asked for", frame())
        assertEquals(before + 1, LookActivity.foreignTraversals)
        assertFalse("the foreign frame lets the cards go off their layers", deck.holdsRestingLayers)
    }

    @Test
    fun aParentScrolledOrAViewMovedWithoutRedrawingIsForeign() {
        show()
        deck.advanceBlobs()
        assertFalse(frame())
        quiet()
        deck.advanceBlobs()
        root.scrollTo(0, 12)
        assertTrue("the backdrop's own parent scrolled", frame())
        quiet()
        deck.advanceBlobs()
        assertFalse(frame())
        quiet()
        val draws = ForeignDraws { false }
        assertNull(draws.first(root, listOf(deck)))
        badge.translationY = 6f
        assertSame("a property-only move shows even when nothing is marked dirty", badge, draws.first(root, listOf(deck)))
    }

    @Test
    fun hidingTheDeckOrStillingItStopsTheTicksAndLetsTheLayersGo() {
        show()
        deck.advanceBlobs()
        assertTrue(deck.holdsRestingLayers)
        assertEquals(View.LAYER_TYPE_HARDWARE, card.layerType)
        root.visibility = View.INVISIBLE
        assertFalse(deck.holdsRestingLayers)
        assertEquals(View.LAYER_TYPE_NONE, card.layerType)
        deck.advanceBlobs()
        assertFalse("a tick that lands while hidden does nothing", deck.holdsRestingLayers)
        root.visibility = View.VISIBLE
        layoutAndDraw()
        quiet()
        deck.advanceBlobs()
        assertTrue(deck.holdsRestingLayers)
        deck.reduceMotion = true
        deck.invalidate()
        layoutAndDraw()
        deck.advanceBlobs()
        assertFalse("a tick after reduce motion came on lets the layers go", deck.holdsRestingLayers)
        deck.reduceMotion = false
        quiet()
        deck.advanceBlobs()
        assertTrue(deck.holdsRestingLayers)
        LookMemory.releaseAll()
        assertFalse("the hidden app's release lets them go too", deck.holdsRestingLayers)
    }
}
