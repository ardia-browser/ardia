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
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
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
class GlassBackdropTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    @Before
    fun lensStandsIn() {
        com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsForTests.setUp()
        GlassShaders.reset()
        GlassShaders.makeRim = { throw IllegalArgumentException("no rim in this test") }
        GlassShaders.makeLens = { android.graphics.RenderEffect.createOffsetEffect(0f, 0f) }
    }

    @After
    fun restore() {
        activity.setContentView(View(activity))
        GlassShaders.reset()
        LookSwitch.forgetForTests()
    }

    private fun <T : View> T.at(left: Int, top: Int, width: Int, height: Int): T = apply { layout(left, top, left + width, top + height) }

    private fun onHardware(view: View) {
        val node = RenderNode("test")
        node.setPosition(0, 0, view.width.coerceAtLeast(1), view.height.coerceAtLeast(1))
        val canvas = node.beginRecording()
        try {
            view.draw(canvas)
        } finally {
            node.endRecording()
        }
    }

    private class Bar(val source: FrostSourceView, val bar: FrameLayout, val backdrop: GlassBackdropView, val fold: FrameLayout, val pillFold: FrameLayout, val glasses: List<GlassView>, val pill: GlassView)

    private fun bar(): Bar {
        val root = FrameLayout(activity)
        activity.setContentView(root)
        val source = FrostSourceView(activity, appContext).apply { sourceId = "backdrop-test" }
        source.addView(View(activity).apply { setBackgroundColor(Color.rgb(30, 120, 200)) })
        root.addView(source)
        val bar = FrameLayout(activity)
        root.addView(bar)
        val backdrop = GlassBackdropView(activity, appContext)
        bar.addView(backdrop)
        val fold = FrameLayout(activity).apply { setLayerType(View.LAYER_TYPE_HARDWARE, null) }
        bar.addView(fold)
        val glasses = listOf(Rect(10, 10, 54, 54), Rect(64, 10, 264, 54)).map { box ->
            GlassView(activity, appContext).apply { this.source = "backdrop-test"; shape = "capsule" }.also(fold::addView) to box
        }
        val pillFold = FrameLayout(activity).apply { setLayerType(View.LAYER_TYPE_HARDWARE, null) }
        bar.addView(pillFold)
        val pill = GlassView(activity, appContext).apply { this.source = "backdrop-test"; shape = "capsule" }.also(pillFold::addView)
        root.measure(View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(470, View.MeasureSpec.EXACTLY))
        root.at(0, 0, 320, 470)
        source.at(0, 0, 320, 470)
        source.getChildAt(0).at(0, 0, 320, 470)
        bar.at(0, 390, 320, 80)
        backdrop.at(0, 0, 320, 80)
        fold.at(0, 0, 320, 80)
        pillFold.at(0, 0, 320, 80)
        glasses.forEach { (glass, box) -> glass.at(box.left, box.top, box.width(), box.height()) }
        pill.at(110, 20, 100, 30)
        return Bar(source, bar, backdrop, fold, pillFold, glasses.map { it.first }, pill)
    }

    private fun live(scene: Bar) {
        onHardware(scene.backdrop)
        onHardware(scene.source)
        onHardware(scene.backdrop)
        (scene.glasses + scene.pill).forEach(::onHardware)
        onHardware(scene.fold)
        onHardware(scene.pillFold)
    }

    @Test
    fun aGlassFindsTheBackdropBeforeItsBranchAndTheBackdropDrawsItInTreeOrder() {
        val scene = bar()
        (scene.glasses + scene.pill).forEach { assertSame(scene.backdrop, it.backdrop) }
        assertEquals("the bar's glasses first, the pill over them", scene.glasses + scene.pill, scene.backdrop.glasses)
        val outside = GlassView(activity, appContext).apply { source = "backdrop-test" }
        scene.source.addView(outside)
        assertNull("a glass with no backdrop before its branch draws itself", outside.backdrop)
    }

    @Test
    fun theBackdropDrawsTheLiveGlassAndTheFoldLayerAboveItIsNotDirtiedWhenTheGlassRedraws() {
        val scene = bar()
        live(scene)
        (scene.glasses + scene.pill).forEach { assertEquals(FrostPage.Path.Live, it.lastChoice?.path) }
        assertEquals("the hosted glasses still share one strip of the source", 1, scene.source.stripsHeld.size)
        assertFalse(scene.fold.isDirty)
        assertFalse(scene.backdrop.isDirty)
        scene.glasses[0].invalidate()
        FrostSources.redrawFrostsOf(scene.source)
        assertTrue("the glass's redraw goes to the backdrop", scene.backdrop.isDirty)
        assertFalse("and leaves the fold's cached layer alone", scene.fold.isDirty)
        assertFalse(scene.glasses[0].isDirty)
        assertFalse(scene.pillFold.isDirty)
    }

    @Test
    fun theBackdropFollowsTheFoldsTransformAndFadeAndSkipsAGlassFadedOut() {
        val scene = bar()
        live(scene)
        val before = scene.backdrop.placement(scene.glasses[1])!!
        assertEquals(1f, before.alpha)
        assertEquals("placed at the glass's offset in the backdrop", 64f, before.matrix[2])
        assertEquals(10f, before.matrix[5])
        scene.fold.scaleX = 0.62f
        scene.fold.alpha = 0.4f
        val folded = scene.backdrop.placement(scene.glasses[1])!!
        assertNotEquals(before, folded)
        assertEquals(0.4f, folded.alpha, 1e-4f)
        assertEquals(0.62f, folded.matrix[0], 1e-4f)
        scene.backdrop.viewTreeObserver.dispatchOnPreDraw()
        assertTrue("a moved or faded fold redraws the backdrop", scene.backdrop.isDirty)
        scene.pillFold.alpha = 0f
        assertNull("a glass faded out by its fold is not drawn", scene.backdrop.placement(scene.pill))
        onHardware(scene.backdrop)
        scene.backdrop.viewTreeObserver.dispatchOnPreDraw()
        assertFalse("a still fold leaves the backdrop alone", scene.backdrop.isDirty)
    }

    @Test
    fun aHiddenGlassWhoseFoldMovesAsksForNothing() {
        val scene = bar()
        live(scene)
        scene.pill.shownMs = 0f
        scene.pill.shown = false
        onHardware(scene.backdrop)
        onHardware(scene.pillFold)
        assertFalse(scene.backdrop.isDirty)
        scene.pillFold.scaleX = 1.6f
        scene.pillFold.translationY = 12f
        scene.backdrop.viewTreeObserver.dispatchOnPreDraw()
        assertFalse("a hidden glass's fold can move without redrawing the backdrop", scene.backdrop.isDirty)
        assertFalse("nor the glass itself", scene.pill.isDirty)
        assertNull(scene.backdrop.placement(scene.pill))
        scene.pill.shown = true
        assertTrue("showing it again draws it", scene.backdrop.isDirty)
    }

    @Test
    fun aBackdropWhoseGlassesAreAllHiddenIsParkedAndDoesNoPerFrameWork() {
        val scene = bar()
        live(scene)
        (scene.glasses + scene.pill).forEach {
            it.shownMs = 0f
            it.shown = false
        }
        onHardware(scene.backdrop)
        assertTrue("with nothing drawn and nothing sampled the backdrop is parked", scene.backdrop.parked)
        val before = scene.backdrop.placementsChecked
        repeat(3) {
            scene.fold.translationY = it * 4f
            scene.pillFold.scaleX = 1f + it * 0.1f
            scene.backdrop.viewTreeObserver.dispatchOnPreDraw()
        }
        assertEquals("a parked backdrop places nothing per frame", before, scene.backdrop.placementsChecked)
        assertFalse(scene.backdrop.isDirty)
        scene.pill.shown = true
        assertFalse("a glass shown again unparks it", scene.backdrop.parked)
        assertTrue(scene.backdrop.isDirty)
        onHardware(scene.backdrop)
        assertTrue(scene.backdrop.placement(scene.pill) != null)
    }

    @Test
    fun aHostedGlassThatChangesSizeRedrawsTheBackdrop() {
        val scene = bar()
        live(scene)
        onHardware(scene.backdrop)
        val wide = scene.backdrop.placement(scene.glasses[1])!!
        assertFalse(scene.backdrop.isDirty)
        scene.glasses[1].at(64, 10, 48, 44)
        assertTrue("the squeezed capsule redraws the backdrop at once", scene.backdrop.isDirty)
        assertNotEquals("and its placement carries its new size", wide, scene.backdrop.placement(scene.glasses[1]))
        onHardware(scene.backdrop)
        scene.glasses[1].at(64, 10, 200, 44)
        scene.backdrop.viewTreeObserver.dispatchOnPreDraw()
        assertTrue(scene.backdrop.isDirty)
    }

    @Test
    fun aTouchBesideTheGlassReachesWhatIsUnderTheBackdrop() {
        val root = FrameLayout(activity).apply { id = 101 }
        activity.setContentView(root)
        val page = View(activity).apply { id = 102 }
        root.addView(page)
        val backdrop = GlassBackdropView(activity, appContext).apply { id = 103 }
        root.addView(backdrop)
        root.measure(View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(470, View.MeasureSpec.EXACTLY))
        root.at(0, 0, 320, 470)
        page.at(0, 0, 320, 470)
        backdrop.at(0, 390, 320, 80)
        assertEquals(com.facebook.react.uimanager.PointerEvents.NONE, backdrop.pointerEvents)
        assertEquals("a tap in the bar's blank space lands on the page", 102, com.facebook.react.uimanager.TouchTargetHelper.findTargetTagForTouch(20f, 430f, root))
    }

    @Test
    fun aHiddenGlassNeverWaitsOnItsSourceSoTheSourceNeverWakesTheBackdrop() {
        val scene = bar()
        scene.pill.shownMs = 0f
        scene.pill.shown = false
        assertNull(scene.pill.lastChoice)
        assertFalse("a hidden glass that never drew waits on nothing", scene.pill.waitsOnSource())
        live(scene)
        onHardware(scene.backdrop)
        assertFalse(scene.backdrop.isDirty)
        for (colour in listOf(Color.GREEN, Color.RED)) {
            scene.source.getChildAt(0).setBackgroundColor(colour)
            scene.source.invalidate()
            onHardware(scene.source)
        }
        assertFalse("the source recording again doesn't wake the backdrop for the hidden pill", scene.backdrop.isDirty)
    }

    @Test
    fun glassesWhoseBackdropGoesDrawThemselvesAgain() {
        val scene = bar()
        live(scene)
        scene.bar.removeView(scene.backdrop)
        (scene.glasses + scene.pill).forEach {
            assertNull("the glass lets go of the removed backdrop", it.backdrop)
            assertTrue("and draws itself", it.isDirty)
        }
        scene.glasses[0].invalidate()
        assertTrue(scene.glasses[0].isDirty)
    }

    @Test
    fun aGlassThatLeavesGoesBackToDrawingItself() {
        val scene = bar()
        live(scene)
        val glass = scene.glasses[0]
        scene.fold.removeView(glass)
        assertNull(glass.backdrop)
        assertFalse(glass in scene.backdrop.glasses)
        assertTrue("its redraw no longer reaches the backdrop's list", scene.backdrop.glasses.size == 2)
    }

    @Test
    fun aBackdropMountedAfterItsGlassesHostsThem() {
        val scene = bar()
        live(scene)
        scene.bar.removeView(scene.backdrop)
        (scene.glasses + scene.pill).forEach { assertNull(it.backdrop) }
        scene.bar.addView(scene.backdrop, 0)
        (scene.glasses + scene.pill).forEach { assertSame("a backdrop that attaches after its glasses takes them back", scene.backdrop, it.backdrop) }
        assertEquals(scene.glasses + scene.pill, scene.backdrop.glasses)
        assertTrue(scene.backdrop.isDirty)
        live(scene)
        assertEquals("and draws them live again", FrostPage.Path.Live, scene.glasses[0].lastChoice?.path)
    }

    @Test
    fun aBackdropAdoptsOnlyTheGlassesThatWouldFindIt() {
        val scene = bar()
        scene.bar.removeView(scene.backdrop)
        val early = GlassView(activity, appContext).apply { source = "backdrop-test" }
        scene.bar.addView(early, 0)
        val pillBackdrop = GlassBackdropView(activity, appContext)
        scene.pillFold.addView(pillBackdrop, 0)
        assertSame("the pill's own backdrop takes the pill", pillBackdrop, scene.pill.backdrop)
        scene.bar.addView(scene.backdrop, 1)
        scene.glasses.forEach { assertSame(scene.backdrop, it.backdrop) }
        assertSame("a glass with a nearer backdrop keeps it", pillBackdrop, scene.pill.backdrop)
        assertNull("a glass before the backdrop is not its to host", early.backdrop)
        assertEquals(scene.glasses, scene.backdrop.glasses)
    }

    @Test
    fun aWholeBranchMountedAtOnceBindsItsGlass() {
        val scene = bar()
        val branch = FrameLayout(activity)
        val backdrop = GlassBackdropView(activity, appContext)
        val layer = FrameLayout(activity)
        val glass = GlassView(activity, appContext).apply { source = "backdrop-test"; shape = "capsule" }
        layer.addView(glass)
        branch.addView(backdrop)
        branch.addView(layer)
        val backdropsBefore = GlassAttachment.backdrops
        val hostedBefore = GlassAttachment.hosted
        scene.bar.addView(branch)
        assertSame(backdrop, glass.backdrop)
        assertEquals(listOf(glass), backdrop.glasses)
        assertEquals("the attached backdrops are counted for the trace", backdropsBefore + 1, GlassAttachment.backdrops)
        assertEquals(hostedBefore + 1, GlassAttachment.hosted)
        scene.bar.removeView(branch)
        assertNull(glass.backdrop)
        assertTrue(backdrop.glasses.isEmpty())
        assertEquals("and a detached branch takes its counts with it", backdropsBefore, GlassAttachment.backdrops)
        assertEquals(hostedBefore, GlassAttachment.hosted)
    }

    @Test
    fun aSharedStripIsNamedForItsSourceAndTheRolesDrawingIt() {
        val scene = bar()
        scene.glasses[0].name = "floatingBarTabs"
        scene.glasses[1].name = "floatingBarAddress"
        scene.pill.name = "hostPill"
        live(scene)
        val strip = scene.source.stripsHeld.single()
        assertEquals("backdrop-test:floatingBarAddress+floatingBarTabs+hostPill", strip.label)
        val shared = strip.node
        scene.pill.shownMs = 0f
        scene.pill.shown = false
        live(scene)
        assertEquals("a role that stops sampling leaves the name", "backdrop-test:floatingBarAddress+floatingBarTabs", strip.label)
        assertNotEquals("and the strip records into a newly named node", shared, strip.node)
        scene.glasses.forEach { assertSame(strip.node, strip.nodeFor(it)) }
        val renamed = strip.node
        live(scene)
        assertSame("an unchanged set of roles keeps its node", renamed, strip.node)
    }

    @Test
    fun aStripWithAnUnnamedConsumerSaysSo() {
        assertEquals("page:hostPill+unnamed", FrostStrip.label("page", listOf("unnamed", "hostPill", "hostPill")))
        assertEquals("unnamed:deckGlass", FrostStrip.label(null, listOf("deckGlass")))
    }
}
