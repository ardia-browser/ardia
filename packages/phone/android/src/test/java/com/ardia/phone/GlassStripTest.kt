package com.ardia.phone

import android.app.Activity
import android.graphics.Color
import android.graphics.Rect
import android.graphics.RenderNode
import android.view.View
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.robolectric.Shadows.shadowOf
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GlassStripTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    private var lensesBuilt = 0
    private var shapesInLens = 0

    @Before
    fun lensStandsIn() {
        com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsForTests.setUp()
        GlassShaders.reset()
        GlassShaders.makeRim = { throw IllegalArgumentException("no rim in this test") }
        GlassShaders.makeLens = { field ->
            lensesBuilt += 1
            shapesInLens = field.lenses.size
            android.graphics.RenderEffect.createOffsetEffect(0f, 0f)
        }
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

    private class Scene(val root: FrameLayout, val source: FrostSourceView, val glasses: List<GlassView>)

    private fun scene(vararg boxes: Rect, sourceId: String = "strip-test"): Scene {
        val root = FrameLayout(activity)
        activity.setContentView(root)
        val source = FrostSourceView(activity, appContext).apply { this.sourceId = sourceId }
        source.addView(View(activity).apply { setBackgroundColor(Color.rgb(30, 120, 200)) })
        root.addView(source)
        val glasses = boxes.map { GlassView(activity, appContext).apply { this.source = sourceId; shape = "capsule" }.also(root::addView) }
        root.measure(View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(470, View.MeasureSpec.EXACTLY))
        root.at(0, 0, 320, 470)
        source.at(0, 0, 320, 470)
        source.getChildAt(0).at(0, 0, 320, 470)
        glasses.forEachIndexed { index, glass -> glass.at(boxes[index].left, boxes[index].top, boxes[index].width(), boxes[index].height()) }
        return Scene(root, source, glasses)
    }

    private fun live(scene: Scene) {
        scene.glasses.forEach(::onHardware)
        onHardware(scene.source)
        scene.glasses.forEach(::onHardware)
        scene.glasses.forEach { assertEquals(FrostPage.Path.Live, it.lastChoice?.path) }
    }

    private fun bar() = scene(Rect(10, 400, 54, 444), Rect(64, 400, 264, 444))

    @Test
    fun everyGlassOverOneSourceSharesOneBlurredStripThatCoversThemAll() {
        val scene = bar()
        live(scene)
        val strip = scene.source.stripsHeld.single()
        assertTrue("the strip reaches past the left glass's margin", strip.left <= 10)
        assertTrue("and past the right one's edge", strip.left + strip.width >= 264)
        assertTrue("it stays a strip near the bar, not the whole page", strip.top >= 300)
        assertEquals("both glasses' shapes go into the one lens", 2, shapesInLens)
        assertEquals(2, strip.lensed)
        assertSame(strip.node, strip.nodeFor(scene.glasses[0]))
        assertEquals(setOf(scene.glasses[0], scene.glasses[1]), strip.consumers.toSet())
        assertEquals(1, scene.source.stripStats.count)
    }

    @Test
    fun aGlassNearTheEdgeReusesTheClampedStripInsteadOfRecordingItOnEveryDraw() {
        val scene = scene(Rect(4, 4, 48, 48))
        live(scene)
        val strip = scene.source.stripsHeld.single()
        val key = strip.key
        val wanted = Rect()
        scene.glasses[0].stripNeed(scene.source, wanted)
        assertTrue("the glass's margin runs past the source's edge", wanted.left < 0 && wanted.top < 0)
        val recorded = strip.records
        val built = lensesBuilt
        for (frame in 1..5) scene.source.join(scene.glasses[0], key, 10_000L + frame * 8L, wanted)
        assertEquals("a still glass draws again without recording the strip", recorded, strip.records)
        assertEquals(built, lensesBuilt)
    }

    @Test
    fun whatMovesUnderTheGlassReachesTheStripWithoutTheUiThreadRecordingIt() {
        val scene = bar()
        live(scene)
        val strip = scene.source.stripsHeld.single()
        val recorded = strip.records
        scene.source.getChildAt(0).setBackgroundColor(Color.GREEN)
        onHardware(scene.source)
        scene.glasses.forEach(::onHardware)
        assertEquals("HWUI carries the source's damage into the strip; nothing re-records it", recorded, strip.records)
    }

    @Test
    fun aChangeUnderTheSourceRedrawsTheWholeStripOnceAFrameSoNoBlurHaloIsLeftBehind() {
        val scene = bar()
        live(scene)
        scene.glasses.forEach(::onHardware)
        val strip = scene.source.stripsHeld.single()
        val records = strip.records
        val tile = View(activity).apply { setBackgroundColor(Color.RED) }
        val clipping = FrameLayout(activity).apply { clipChildren = true; addView(tile) }
        scene.source.addView(clipping)
        clipping.at(20, 410, 8, 8)
        tile.at(0, 0, 8, 8)
        onHardware(scene.source)
        scene.source.viewTreeObserver.dispatchOnPreDraw()
        scene.glasses.forEach(::onHardware)
        val before = strip.refreshes
        tile.setBackgroundColor(Color.GREEN)
        tile.setBackgroundColor(Color.BLUE)
        assertEquals("nothing is recorded while the change is made", before, strip.refreshes)
        scene.source.viewTreeObserver.dispatchOnPreDraw()
        assertEquals("a tile in a small clipping parent re-records the whole filtered strip once before the frame", before + 1, strip.refreshes)
        scene.source.viewTreeObserver.dispatchOnPreDraw()
        assertEquals("and a frame with no change under the source leaves it", before + 1, strip.refreshes)
        assertEquals("the strip's layout is not recorded again", records, strip.records)
        assertTrue("and no glass is asked to draw for it", scene.glasses.none { it.isDirty })
    }

    @Test
    fun hidingAGlassWakesAGlassOnItsOwnStripAndChangingKeysWakesTheStripLeftBehind() {
        val scene = scene(Rect(10, 400, 54, 444), Rect(64, 400, 108, 444), Rect(118, 400, 162, 444))
        live(scene)
        scene.glasses.forEach(::onHardware)
        assertTrue(scene.glasses.none { it.isDirty })
        val wanted = Rect()
        val key = scene.glasses[1].stripNeed(scene.source, wanted)!!
        val denser = key.copy(blurPx = key.blurPx * 2f, scale = FrostScale.of(key.blurPx * 2f))
        scene.source.join(scene.glasses[1], denser, 9_000L, wanted)
        assertTrue("a glass leaving for another key wakes one still on the old strip", scene.glasses[0].isDirty)
        scene.source.join(scene.glasses[2], denser, 9_000L, wanted)
        assertEquals(2, scene.source.stripsHeld.size)
        assertFalse(scene.glasses[2].isDirty)
        scene.glasses[1].forgetLayer()
        assertTrue("the glass left on the hidden one's strip is the one woken", scene.glasses[2].isDirty)
    }

    @Test
    fun aSourceNamedAfterItsFirstDrawIsAskedToDrawForTheGlassWaitingOnIt() {
        val root = FrameLayout(activity)
        activity.setContentView(root)
        val source = FrostSourceView(activity, appContext)
        source.addView(View(activity).apply { setBackgroundColor(Color.MAGENTA) })
        root.addView(source)
        val glass = GlassView(activity, appContext).apply { this.source = "named-late"; shape = "capsule" }
        root.addView(glass)
        root.measure(View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(470, View.MeasureSpec.EXACTLY))
        root.at(0, 0, 320, 470)
        source.at(0, 0, 320, 470)
        source.getChildAt(0).at(0, 0, 320, 470)
        glass.at(10, 400, 44, 44)
        onHardware(source)
        onHardware(glass)
        assertEquals(FrostPage.NO_SOURCE, glass.lastChoice?.reason)
        onHardware(source)
        assertFalse(source.isDirty)
        source.sourceId = "named-late"
        assertTrue("registration asks the source to draw, not only the glass", source.isDirty)
        onHardware(source)
        assertTrue(source.isRecording)
    }

    @Test
    fun aSourceDrawingAgainLeavesItsLiveGlassesAloneSoNoSecondFrameIsScheduled() {
        val scene = bar()
        live(scene)
        scene.glasses.forEach(::onHardware)
        assertTrue(scene.glasses.none { it.isDirty })
        for (colour in listOf(Color.GREEN, Color.RED, Color.BLUE)) {
            scene.source.getChildAt(0).setBackgroundColor(colour)
            onHardware(scene.source)
        }
        assertTrue("a live glass is not invalidated from inside the source's draw", scene.glasses.none { it.isDirty })
        assertTrue(scene.glasses.none { it.waitsOnSource() })
    }

    @Test
    fun onlyAGlassStillWaitingForItsSourceIsWokenWhenTheSourceDraws() {
        val scene = bar()
        scene.glasses.forEach(::onHardware)
        assertEquals(FrostPage.SOURCE_NOT_DRAWN, scene.glasses[0].lastChoice?.reason)
        assertTrue(scene.glasses.all { it.waitsOnSource() })
        onHardware(scene.source)
        assertTrue("the source's first recording wakes the glasses waiting on it", scene.glasses.all { it.isDirty })
        onHardware(scene.glasses[0])
        assertEquals(FrostPage.Path.Live, scene.glasses[0].lastChoice?.path)
        assertFalse(scene.glasses[0].waitsOnSource())
        assertTrue("the glass that has not drawn since still waits", scene.glasses[1].waitsOnSource())
        onHardware(scene.source)
        assertFalse("the live one is left alone", scene.glasses[0].isDirty)
        assertTrue(scene.glasses[1].isDirty)
        scene.glasses[1].reduceTransparency = true
        onHardware(scene.glasses[1])
        assertFalse("a glass that cannot blur waits on nothing", scene.glasses[1].waitsOnSource())
    }

    @Test
    fun aSourceThatChangesSizeAsksItsGlassesToLayTheStripOutAgain() {
        val scene = bar()
        live(scene)
        scene.glasses.forEach(::onHardware)
        scene.source.at(0, 0, 320, 300)
        assertTrue(scene.glasses.all { it.isDirty })
    }

    @Test
    fun aGlassThatLeavesTakesItsLensWithItAndTheLastOneEvictsTheStrip() {
        val scene = bar()
        live(scene)
        val strip = scene.source.stripsHeld.single()
        scene.glasses[1].forgetLayer()
        assertEquals(setOf<FrostView>(scene.glasses[0]), strip.consumers.toSet())
        assertTrue("the glass still showing draws again to lay the strip out", scene.glasses[0].isDirty)
        onHardware(scene.glasses[0])
        assertEquals("the lens is rebuilt for the glass still there", 1, strip.lensed)
        assertEquals(1, shapesInLens)
        assertTrue("and the strip shrinks to it", strip.left + strip.width < 264)
        scene.glasses[0].forgetLayer()
        assertEquals(0, scene.source.stripsHeld.size)
        assertEquals(0, scene.source.stripStats.count)
    }

    @Test
    fun aHiddenGlassGivesUpItsPlaceInTheStrip() {
        val scene = bar()
        live(scene)
        val strip = scene.source.stripsHeld.single()
        scene.glasses[1].shownMs = 0f
        scene.glasses[1].shown = false
        assertEquals("hidden by its shown prop", setOf<FrostView>(scene.glasses[0]), strip.consumers.toSet())
        assertFalse(scene.glasses[1].samplesNow)
        scene.glasses[1].shown = true
        onHardware(scene.glasses[1])
        assertEquals(setOf<FrostView>(scene.glasses[0], scene.glasses[1]), strip.consumers.toSet())
        scene.glasses[1].visibility = View.INVISIBLE
        assertEquals("hidden by its visibility, which Android may never draw", setOf<FrostView>(scene.glasses[0]), strip.consumers.toSet())
        assertFalse(scene.glasses[1].samplesNow)
    }

    @Test
    fun aGlassMovedToAnIdleSourceLeavesTheOldOneAndWakesTheNew() {
        val scene = bar()
        live(scene)
        val idle = FrostSourceView(activity, appContext).apply { sourceId = "idle-source" }
        idle.addView(View(activity).apply { setBackgroundColor(Color.YELLOW) })
        scene.root.addView(idle, 1)
        idle.at(0, 0, 320, 470)
        idle.getChildAt(0).at(0, 0, 320, 470)
        onHardware(idle)
        assertFalse("nobody wants it yet", idle.isRecording)
        scene.glasses.forEach(::onHardware)
        scene.glasses[0].source = "idle-source"
        assertEquals("it leaves the old strip at once", setOf<FrostView>(scene.glasses[1]), scene.source.stripsHeld.single().consumers.toSet())
        assertTrue("the new source is asked to draw", idle.isDirty)
        assertTrue(scene.glasses[0].isDirty)
        assertTrue(FrostSources.anyFrostCanBlur("idle-source"))
        onHardware(idle)
        assertTrue("and records on that draw", idle.isRecording)
        onHardware(scene.glasses[0])
        assertEquals(FrostPage.Path.Live, scene.glasses[0].lastChoice?.path)
        assertEquals(setOf<FrostView>(scene.glasses[0]), idle.stripsHeld.single().consumers.toSet())
    }

    @Test
    fun aGlassThatMovesToAnotherKeyLeavesItsOldStripBehind() {
        val scene = bar()
        live(scene)
        val old = scene.source.stripsHeld.single()
        val wanted = Rect()
        val key = scene.glasses[0].stripNeed(scene.source, wanted)!!
        val denser = key.copy(blurPx = key.blurPx * 2f, scale = FrostScale.of(key.blurPx * 2f))
        scene.source.join(scene.glasses[0], denser, 5_000L, wanted)
        scene.source.join(scene.glasses[1], denser, 5_000L, wanted)
        assertEquals("a density change leaves no strip for the old key", listOf(denser), scene.source.stripsHeld.map { it.key })
        assertEquals(0, old.width)
    }

    @Test
    fun theFirstTwelveGlassesByAgeHoldTheLensSlotsAndTheThirteenthSamplesThePlainBlur() {
        val boxes = (0 until 13).map { index -> Rect(4 + (index % 6) * 52, 40 + (index / 6) * 60, 4 + (index % 6) * 52 + 44, 40 + (index / 6) * 60 + 44) }
        val scene = scene(*boxes.toTypedArray())
        scene.glasses.reversed().forEach(::onHardware)
        onHardware(scene.source)
        scene.glasses.reversed().forEach(::onHardware)
        val strip = scene.source.stripsHeld.single()
        assertEquals(LiquidGlassRules.MAX_LENSES, strip.lensed)
        val youngest = scene.glasses.maxBy { it.number }
        assertTrue("an overflow glass draws a plain blur, not a neighbour's refraction", strip.holdsPlain)
        assertNotSame(strip.node, strip.nodeFor(youngest))
        scene.glasses.filter { it !== youngest }.forEach { assertSame(strip.node, strip.nodeFor(it)) }
        val plain = strip.nodeFor(youngest)
        scene.glasses.first { it !== youngest }.forgetLayer()
        val wanted = Rect()
        val key = youngest.stripNeed(scene.source, wanted)!!
        scene.source.join(youngest, key, 7_000L, wanted)
        assertSame("a freed slot goes to the glass that was waiting", strip.node, strip.nodeFor(youngest))
        assertFalse(strip.holdsPlain)
        assertTrue("the plain layer outlives the frame that retired it, for any glass that drew it earlier", strip.retiring > 0)
        assertNotSame(strip.node, plain)
        shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(50))
        assertEquals("and goes after the next frame, even when no glass draws again", 0, strip.retiring)
    }

    @Test
    fun aReplacedSourceRedrawsItsGlassesAndIsAskedToRecordForThem() {
        val first = bar()
        live(first)
        first.glasses.forEach(::onHardware)
        first.root.removeView(first.source)
        assertTrue("the glasses drop the discarded strip at once", first.glasses.all { it.isDirty })
        first.glasses.forEach(::onHardware)
        assertEquals(FrostPage.NO_SOURCE, first.glasses[0].lastChoice?.reason)
        assertTrue("a glass with no source still wants one", first.glasses[0].wantsSource())
        val replacement = FrostSourceView(activity, appContext).apply { sourceId = "strip-test" }
        replacement.addView(View(activity).apply { setBackgroundColor(Color.RED) })
        first.root.addView(replacement, 0)
        replacement.at(0, 0, 320, 470)
        replacement.getChildAt(0).at(0, 0, 320, 470)
        assertTrue("the new source asks its glasses to draw again", first.glasses.all { it.isDirty })
        assertTrue(FrostSources.anyFrostCanBlur("strip-test"))
        onHardware(replacement)
        assertTrue("and records for them on its first draw", replacement.isRecording)
    }

    @Test
    fun aLabSwitchFromTheJsThreadTouchesViewsOnlyOnTheUiThread() {
        var ran = 0
        var onMain = false
        val worker = Thread { LookThread.onMain { ran += 1; onMain = android.os.Looper.myLooper() == android.os.Looper.getMainLooper() } }
        worker.start()
        worker.join()
        assertEquals("posted, not run on the JS thread", 0, ran)
        shadowOf(android.os.Looper.getMainLooper()).idle()
        assertEquals(1, ran)
        assertTrue(onMain)
        LookThread.onMain { ran += 1 }
        assertEquals("already on the UI thread it runs at once", 2, ran)
    }
}
