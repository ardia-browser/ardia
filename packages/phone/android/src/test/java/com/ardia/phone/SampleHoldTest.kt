package com.ardia.phone

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.RenderNode
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import java.time.Duration
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SampleHoldTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    private val captured = ArrayList<Pair<RenderNode, Bitmap>>()
    private var captureFails = false
    private var attempts = 0

    @Before
    fun shadersStandIn() {
        com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsForTests.setUp()
        GlassShaders.reset()
        GlassShaders.makeRim = { throw IllegalArgumentException("no rim in this test") }
        GlassShaders.makeLens = { android.graphics.RenderEffect.createOffsetEffect(0f, 0f) }
    }

    @After
    fun restore() {
        GlassShaders.reset()
        LookSwitch.forgetForTests()
    }

    private fun <T : View> T.at(left: Int, top: Int, width: Int, height: Int): T = apply { layout(left, top, left + width, top + height) }

    private fun onHardware(view: View) {
        val node = RenderNode("test")
        node.setPosition(0, 0, view.width.coerceAtLeast(1), view.height.coerceAtLeast(1))
        val canvas = node.beginRecording()
        try {
            assertTrue(canvas.isHardwareAccelerated)
            view.draw(canvas)
        } finally {
            node.endRecording()
        }
    }

    private class Scene(val source: FrostSourceView, val page: View, val pill: GlassView)

    private fun scene(key: String? = "tab-1:open:light"): Scene {
        val root = FrameLayout(activity)
        activity.setContentView(root)
        val sourceName = "page-${java.util.UUID.randomUUID()}"
        val source = FrostSourceView(activity, appContext).apply { sourceId = sourceName }
        val page = View(activity).apply { setBackgroundColor(Color.rgb(30, 120, 200)) }
        source.addView(page)
        source.findScroller = { page }
        root.addView(source)
        val pill = GlassView(activity, appContext).apply {
            this.source = sourceName
            name = "hostPill"
            shape = "capsule"
            sampleCapture = SampleCapture { node, width, height, done ->
                attempts += 1
                if (captureFails) return@SampleCapture done(null)
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                captured += node to bitmap
                done(bitmap)
            }
        }
        root.addView(pill, FrameLayout.LayoutParams(90, 35).apply { leftMargin = 115; topMargin = 380 })
        root.measure(View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(470, View.MeasureSpec.EXACTLY))
        root.at(0, 0, 320, 470)
        source.at(0, 0, 320, 470)
        page.at(0, 0, 320, 470)
        pill.at(115, 380, 90, 35)
        pill.sampleHold = key
        frame(source, pill)
        frame(source, pill)
        assertEquals("${pill.lastChoice?.reason}", FrostPage.Path.Live, pill.lastChoice?.path)
        return Scene(source, page, pill)
    }

    private fun frame(source: FrostSourceView, pill: GlassView) {
        onHardware(source)
        onHardware(pill)
    }

    private fun Scene.frame() = frame(source, pill)

    private fun Scene.scroll(by: Int) {
        page.scrollBy(0, by)
        pill.pageScrolled()
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun Scene.settle() = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(SampleHoldRules.SETTLE_MS + 40))

    private fun Scene.held(): Scene {
        scroll(24)
        frame()
        assertTrue("the pill holds its sample once the page scrolls: ${pill.lastChoice}", pill.sampleHeld)
        return this
    }

    @Test
    fun aScrollCapturesThePillsOwnFilteredLayerAsPixelsAndDrawsThemInsteadOfTheLiveStrip() {
        val scene = scene()
        val layer = scene.pill.layerWidth to scene.pill.layerHeight
        scene.scroll(24)
        assertEquals("one capture as the scroll starts", 1, captured.size)
        assertEquals("of the layer the pill drew live, at its size", layer, captured[0].second.width to captured[0].second.height)
        val sample = scene.pill.heldSample
        assertNotNull(sample)
        assertSame("the held sample is the captured bitmap, not a node over the page", captured[0].second, sample!!.bitmap)
        scene.frame()
        assertTrue(scene.pill.sampleHeld)
        assertEquals(SampleHoldRules.HELD_REASON, scene.pill.lastChoice?.reason)
        assertFalse("the pill lets go of its live layer", scene.pill.holdsLayer)
        assertTrue("and leaves the strip, so nothing consumes it", scene.source.stripsHeld.isEmpty())
        assertEquals(0, scene.source.stripConsumers)
    }

    @Test
    fun whileHeldThePageSourceStopsRecordingAndNoFrameCapturesOrRecordsAgain() {
        val scene = scene().held()
        scene.frame()
        assertFalse("with no live consumer the page source stops recording", scene.source.isRecording)
        assertFalse(scene.pill.wantsSource())
        val recordings = LookActivity.sourceRecordings
        val renders = LookActivity.blurLayerRenders
        repeat(6) {
            scene.scroll(30)
            scene.frame()
        }
        assertEquals("the source is not recorded once through the scroll", recordings, LookActivity.sourceRecordings)
        assertEquals("nor the pill's blur layer", renders, LookActivity.blurLayerRenders)
        assertEquals("and the sample is captured once", 1, captured.size)
        assertTrue(scene.pill.sampleHeld)
        assertFalse(scene.source.isRecording)
    }

    @Test
    fun onScrollIdleThePillBridgesOnItsSampleUntilTheSourceRecordsThenGoesLiveAndDropsIt() {
        val scene = scene().held()
        scene.frame()
        scene.settle()
        assertFalse(scene.pill.pageScrolling)
        onHardware(scene.pill)
        assertFalse(scene.pill.sampleHeld)
        assertEquals("the first frame back waits on the source", FrostPage.SOURCE_NOT_DRAWN, scene.pill.lastChoice?.reason)
        assertNotNull("and draws the held pixels rather than a flat fill", scene.pill.heldSample)
        assertTrue("the pill asks for its source again", scene.pill.wantsSource())
        scene.frame()
        scene.frame()
        assertTrue(scene.source.isRecording)
        assertEquals(FrostPage.Path.Live, scene.pill.lastChoice?.path)
        assertNull("the stale sample is dropped once live", scene.pill.heldSample)
        assertEquals(1, scene.source.stripConsumers)
        scene.scroll(24)
        assertEquals("the next scroll captures afresh", 2, captured.size)
    }

    @Test
    fun aNewTabPrivacyOrToneKeyDropsTheSampleAndTheHold() {
        val scene = scene().held()
        scene.pill.sampleHold = "tab-2:open:light"
        assertNull(scene.pill.heldSample)
        assertFalse(scene.pill.sampleHeld)
        scene.frame()
        scene.frame()
        assertEquals(FrostPage.Path.Live, scene.pill.lastChoice?.path)
        assertFalse(scene.pill.sampleHeld)
    }

    @Test
    fun theNativeToneOrTheLookChangingUnderAHoldDropsIt() {
        val scene = scene().held()
        scene.pill.dark = true
        onHardware(scene.pill)
        assertFalse("a darker pill does not reuse a light sample", scene.pill.sampleHeld)
        assertNull(scene.pill.heldSample)
        val other = scene().held()
        other.pill.color = "green"
        onHardware(other.pill)
        assertFalse("nor does a new look", other.pill.sampleHeld)
    }

    @Test
    fun aPillThatMovesOrResizesUnderAHoldDropsIt() {
        val moved = scene().held()
        moved.pill.at(115, 340, 90, 35)
        onHardware(moved.pill)
        assertFalse(moved.pill.sampleHeld)
        assertNull(moved.pill.heldSample)
        val resized = scene().held()
        resized.pill.at(115, 380, 120, 35)
        onHardware(resized.pill)
        assertFalse(resized.pill.sampleHeld)
    }

    @Test
    fun expandingThePillUnarmsTheHoldAndTheSourceComesBack() {
        val scene = scene().held()
        scene.pill.sampleHold = null
        assertFalse(scene.pill.sampleHeld)
        assertFalse(scene.pill.pageScrolling)
        scene.frame()
        scene.frame()
        assertTrue(scene.source.isRecording)
        scene.scroll(24)
        assertEquals("an unarmed pill never captures", 1, captured.size)
        assertFalse(scene.pill.pageScrolling)
    }

    @Test
    fun anUnarmedPillStaysLiveThroughAScroll() {
        val scene = scene(key = null)
        scene.scroll(24)
        scene.frame()
        assertTrue(captured.isEmpty())
        assertFalse(scene.pill.sampleHeld)
        assertEquals(FrostPage.Path.Live, scene.pill.lastChoice?.path)
        assertTrue(scene.source.isRecording)
    }

    @Test
    fun aFailedCaptureLeavesThePillLiveAndRetriesOnlyOnceInAScroll() {
        captureFails = true
        val scene = scene()
        scene.scroll(24)
        repeat(5) {
            scene.frame()
            shadowOf(Looper.getMainLooper()).idle()
            scene.scroll(10)
        }
        assertFalse(scene.pill.sampleHeld)
        assertEquals(FrostPage.Path.Live, scene.pill.lastChoice?.path)
        assertEquals(0, scene.pill.samplesCaptured)
        assertEquals("a scroll tries at most twice", SampleHoldRules.CAPTURE_TRIES, attempts)
    }

    @Test
    fun aScrollThatIsNotThePagesDoesNotHold() {
        val scene = scene()
        scene.pill.pageScrolled()
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(scene.pill.pageScrolling)
        assertTrue(captured.isEmpty())
    }
}
