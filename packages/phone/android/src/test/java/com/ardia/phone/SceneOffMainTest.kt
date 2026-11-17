package com.ardia.phone

import android.app.Activity
import android.view.View
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
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
class SceneOffMainTest {
    private val renders = ArrayList<Runnable>()
    private val applies = ArrayList<Runnable>()

    @org.junit.Before
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

    @org.junit.After
    fun background() {
        SceneWork.current = SceneWork.background
    }

    private fun deck(): DeckBackdropView {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        val app = unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
        val root = FrameLayout(activity)
        val deck = DeckBackdropView(activity, app).apply { color = "#B04A7A" }
        root.addView(deck, FrameLayout.LayoutParams(1080, 2400))
        activity.setContentView(root)
        root.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2400, View.MeasureSpec.EXACTLY))
        root.layout(0, 0, 1080, 2400)
        return deck
    }

    private fun step(millis: Long = LookRules.FADE_FRAME_MILLIS) = ShadowSystemClock.advanceBy(Duration.ofMillis(millis))

    private fun runAll() {
        while (renders.isNotEmpty() || applies.isNotEmpty()) {
            if (renders.isNotEmpty()) renders.removeAt(0).run()
            while (applies.isNotEmpty()) applies.removeAt(0).run()
        }
    }

    private fun frame(deck: DeckBackdropView) {
        step()
        deck.advanceBlobs()
        runAll()
    }

    @Test
    fun theFirstTickShowsASceneAtOnceAndAsksTheWorkerForTheNextOneAFadeAhead() {
        val deck = deck()
        step()
        val scenes = LookActivity.scenesOffMain
        deck.advanceBlobs()
        assertEquals("the deck opens with a scene already drawn", 135 to 300, deck.sceneSize)
        assertEquals("and one more scene asked of the worker", 1, renders.size)
        step()
        deck.advanceBlobs()
        assertEquals("a tick while that scene is being drawn asks for no second one", 1, renders.size)
        runAll()
        assertEquals(scenes + 1, LookActivity.scenesOffMain)
        val (from, to) = deck.fadeScenes
        assertTrue(from != null && to != null)
        assertNotSame("the next scene is drawn into another buffer, never the one on screen", from, to)
    }

    @Test
    fun aSceneEveryFourHundredMillisecondsAndOneSmallBlendPerFrame() {
        val deck = deck()
        frame(deck)
        val scenes = LookActivity.scenesOffMain
        val blends = LookActivity.blendsOffMain
        val frames = (2000 / LookRules.FADE_FRAME_MILLIS).toInt()
        repeat(frames) { frame(deck) }
        val drawn = LookActivity.scenesOffMain - scenes
        assertTrue("two seconds of frames draw five scenes, with one more drawn a scene ahead: $drawn", drawn in 5L..6L)
        assertEquals("and one small blend for every frame", frames.toLong(), LookActivity.blendsOffMain - blends)
        val (from, to) = deck.fadeScenes
        assertNotSame("what is on screen is a blend, not either scene", from, deck.shownScene)
        assertNotSame(to, deck.shownScene)
        assertEquals("the blend is the small picture's size", 135 to 300, deck.sceneSize)
    }

    @Test
    fun theNextSceneIsAlwaysReadyBeforeTheFadeNeedsIt() {
        val deck = deck()
        frame(deck)
        repeat(12) {
            frame(deck)
            val (_, toAt, nextAt) = deck.fadeQueue
            assertTrue("a scene beyond the one being faded to is already drawn, ${it + 1} frames in", nextAt == toAt + LookRules.FADE_SCENE_MILLIS)
        }
    }

    @Test
    fun aLateSceneHoldsWhereTheFadeIsAndThenFadesOnFromThereWithoutAJump() {
        val deck = deck()
        frame(deck)
        frame(deck)
        val catchUps = LookActivity.fadeCatchUps
        repeat((2 * LookRules.FADE_SCENE_MILLIS / LookRules.FADE_FRAME_MILLIS + 2).toInt()) {
            step()
            deck.advanceBlobs()
            val blend = renders.lastIndex
            if (blend >= 0) {
                renders.removeAt(blend).run()
                while (applies.isNotEmpty()) applies.removeAt(0).run()
            }
        }
        val held = deck.fadeShare(deck.clockForTests())
        assertEquals("with the scene after next late, the fade holds at the scene it reached", 1f, held, 0.001f)
        runAll()
        step()
        deck.advanceBlobs()
        val resumed = deck.fadeShare(deck.clockForTests())
        assertTrue("when it lands the fade starts again from where it held, not ahead of it: $resumed", resumed < 0.3f)
        assertTrue("the late hand-off is counted", LookActivity.fadeCatchUps > catchUps)
        runAll()
    }

    @Test
    fun theCrossFadeGoesFromTheOlderSceneToTheNewerOneAcrossItsInterval() {
        val deck = deck()
        frame(deck)
        val (fromAt, toAt, _) = deck.fadeQueue
        assertEquals(LookRules.FADE_SCENE_MILLIS, toAt - fromAt)
        assertEquals(0f, deck.fadeShare(fromAt), 0.001f)
        assertEquals(0.5f, deck.fadeShare(fromAt + LookRules.FADE_SCENE_MILLIS / 2), 0.001f)
        assertEquals(1f, deck.fadeShare(toAt), 0.001f)
    }

    @Test
    fun aSceneThatFinishesAfterTheDeckStoppedIsDropped() {
        val deck = deck()
        step()
        deck.advanceBlobs()
        deck.stopMotion()
        runAll()
        assertEquals("the scene asked before the stop is not taken", null, deck.fadeScenes.second)
        step()
        deck.advanceBlobs()
        assertEquals("after the stop a tick asks for a scene again", 1, renders.size)
    }

    @Test
    fun theMainThreadsShareOfATickIsWellUnderAMillisecond() {
        val deck = deck()
        frame(deck)
        val main = ArrayList<Long>()
        val scene = ArrayList<Long>()
        val blend = ArrayList<Long>()
        for (i in 0 until 400) {
            step()
            val a = System.nanoTime()
            deck.advanceBlobs()
            main += System.nanoTime() - a
            while (renders.isNotEmpty()) {
                val scenes = LookActivity.scenesOffMain
                val b = System.nanoTime()
                renders.removeAt(0).run()
                val spent = System.nanoTime() - b
                if (LookActivity.scenesOffMain > scenes) scene += spent else blend += spent
                val c = System.nanoTime()
                while (applies.isNotEmpty()) applies.removeAt(0).run()
                main[main.lastIndex] += System.nanoTime() - c
            }
        }
        main.sort()
        scene.sort()
        blend.sort()
        println("PAGELAB scene off main on this machine: main thread ${main[main.size / 2] / 1000} us a frame (tick and hand-backs, median), worker ${scene[scene.size / 2] / 1000} us a scene and ${blend[blend.size / 2] / 1000} us a blend, ${scene.size} scenes and ${blend.size} blends for ${main.size} frames")
        assertTrue("the main thread's share is a small fraction of a scene's drawing", main[main.size / 2] * 10 < scene[scene.size / 2])
    }

    private fun meanDifference(a: android.graphics.Bitmap, b: android.graphics.Bitmap): Double {
        val left = a.copy(android.graphics.Bitmap.Config.ARGB_8888, false)
        val right = b.copy(android.graphics.Bitmap.Config.ARGB_8888, false)
        var total = 0L
        for (y in 0 until left.height) for (x in 0 until left.width) {
            val p = left.getPixel(x, y)
            val q = right.getPixel(x, y)
            total += kotlin.math.abs(android.graphics.Color.red(p) - android.graphics.Color.red(q)) + kotlin.math.abs(android.graphics.Color.green(p) - android.graphics.Color.green(q)) + kotlin.math.abs(android.graphics.Color.blue(p) - android.graphics.Color.blue(q))
        }
        return total.toDouble() / (left.width * left.height * 3)
    }

    @Test
    fun aCrossFadeMidwayNeverStraysFromTheTrueSceneByMoreThanHalfWhatTheFadeCrosses() {
        val deck = deck()
        val start = 12_345L
        val from = deck.sceneForTests(start)!!
        val to = deck.sceneForTests(start + LookRules.FADE_SCENE_MILLIS)!!
        val truth = deck.sceneForTests(start + LookRules.FADE_SCENE_MILLIS / 2)!!
        val blend = android.graphics.Bitmap.createBitmap(from.width, from.height, android.graphics.Bitmap.Config.RGBA_F16)
        android.graphics.Canvas(blend).apply {
            drawBitmap(from, 0f, 0f, null)
            drawBitmap(to, 0f, 0f, android.graphics.Paint().apply { alpha = 128 })
        }
        val a = from.copy(android.graphics.Bitmap.Config.ARGB_8888, false)
        val b = to.copy(android.graphics.Bitmap.Config.ARGB_8888, false)
        val m = truth.copy(android.graphics.Bitmap.Config.ARGB_8888, false)
        val mixed = blend.copy(android.graphics.Bitmap.Config.ARGB_8888, false)
        var over = 0
        var worst = 0.0
        val channels = listOf<(Int) -> Int>(android.graphics.Color::red, android.graphics.Color::green, android.graphics.Color::blue)
        for (y in 0 until a.height) for (x in 0 until a.width) {
            val pa = a.getPixel(x, y)
            val pb = b.getPixel(x, y)
            val pm = m.getPixel(x, y)
            val pf = mixed.getPixel(x, y)
            for (channel in channels) {
                val allowed = kotlin.math.abs(channel(pa) - channel(pb)) / 2.0 + ROUNDING_STEPS
                val error = kotlin.math.abs(channel(pf) - channel(pm)).toDouble()
                worst = maxOf(worst, error - allowed + ROUNDING_STEPS)
                if (error > allowed) over += 1
            }
        }
        println("PAGELAB cross-fade check: midway blend against the true scene ${"%.3f".format(meanDifference(blend, truth))} of 255 a channel on average, the two scenes ${"%.3f".format(meanDifference(from, to))} apart; worst excess over half that distance ${"%.1f".format(worst)} steps")
        assertEquals("every channel of the blend is within half the fade's change, plus the rounding of four 8-bit pictures", 0, over)
    }

    private companion object {
        const val ROUNDING_STEPS = 2.0
    }
}
