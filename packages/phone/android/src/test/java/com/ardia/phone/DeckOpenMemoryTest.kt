package com.ardia.phone

import android.app.Activity
import android.view.View
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import java.time.Duration
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
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
class DeckOpenMemoryTest {
    private val renders = ArrayList<Runnable>()
    private val applies = ArrayList<Runnable>()

    @Before
    fun deferred() {
        com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsForTests.setUp()
        SceneWork.current = object : SceneWork {
            override fun render(job: Runnable) {
                renders += job
            }

            override fun toMain(job: Runnable) {
                applies += job
            }
        }
    }

    @After
    fun background() {
        SceneWork.current = SceneWork.background
    }

    private val app: AppContext by lazy {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    private class Deck(val tree: View, val backdrop: DeckBackdropView, val resting: View)

    private fun open(activity: Activity, host: FrameLayout): Deck {
        val source = FrostSourceView(activity, app).apply { sourceId = "deck" }
        val backdrop = DeckBackdropView(activity, app).apply { color = "#B04A7A" }
        val cards = (0 until 3).map { View(activity) }
        val stack = FrameLayout(activity).apply { cards.forEach { addView(it, FrameLayout.LayoutParams(400, 800)) } }
        source.addView(backdrop, FrameLayout.LayoutParams(1080, 2400))
        source.addView(stack, FrameLayout.LayoutParams(1080, 2400))
        val bar = FrostView(activity, app).apply { this.source = "deck" }
        val tree = FrameLayout(activity).apply {
            addView(source, FrameLayout.LayoutParams(1080, 2400))
            addView(bar, FrameLayout.LayoutParams(204, 105))
        }
        host.addView(tree, FrameLayout.LayoutParams(1080, 2400))
        host.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2400, View.MeasureSpec.EXACTLY))
        host.layout(0, 0, 1080, 2400)
        backdrop.layout(0, 0, 1080, 2400)
        stack.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2400, View.MeasureSpec.EXACTLY))
        stack.layout(0, 0, 1080, 2400)
        return Deck(tree, backdrop, stack)
    }

    private fun runAll() {
        while (renders.isNotEmpty() || applies.isNotEmpty()) {
            if (renders.isNotEmpty()) renders.removeAt(0).run()
            while (applies.isNotEmpty()) applies.removeAt(0).run()
        }
    }

    @Test
    fun fiveDeckOpensLeaveNothingOfTheLookBehindOnceEachDeckCloses() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val host = FrameLayout(activity)
        activity.setContentView(host)
        var heldLayers = 0
        repeat(5) { opening ->
            val deck = open(activity, host)
            assertEquals("deck $opening is the only backdrop while it is open", 1, LookMemory.counts().decks)
            assertEquals(1, LookMemory.counts().frosts)
            assertEquals(1, LookMemory.counts().sources)
            ShadowSystemClock.advanceBy(Duration.ofMillis(1100))
            repeat(12) {
                ShadowSystemClock.advanceBy(Duration.ofMillis(LookRules.FADE_FRAME_MILLIS))
                deck.backdrop.advanceBlobs()
                runAll()
            }
            if (deck.backdrop.holdsRestingLayers && deck.resting.layerType == View.LAYER_TYPE_HARDWARE) heldLayers += 1
            host.removeView(deck.tree)
            runAll()
            val after = LookMemory.counts()
            assertEquals("deck $opening's backdrop is forgotten when it closes", 0, after.decks)
            assertEquals("its frosts are forgotten", 0, after.frosts)
            assertEquals("its frost sources are forgotten", 0, after.sources)
            assertEquals("no frost keeps a blur layer", 0, after.holdingLayers)
            assertEquals("no source keeps recording", 0, after.recording)
            assertEquals("the cards it held on a layer while the blobs moved are back on no layer", View.LAYER_TYPE_NONE, deck.resting.layerType)
        }
        assertEquals("the resting cards were held on layers while each deck's blobs moved, so the release above was exercised", 5, heldLayers)
    }
}
