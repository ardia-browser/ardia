package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.math.abs

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MotionPlanTest {
    private val depart = MotionCurve.Timing(200, listOf(0.2f, 0f, 0f, 1f))
    private val expand = MotionCurve.Spring(0.18, 1.0)
    private val departed = MotionValues(opacity = 0f, translateY = -120f)

    private class Clock(val durationMillis: Long, val onFrame: (Float) -> Unit, val onEnd: (Boolean) -> Unit) : MotionClock {
        override var fraction = 0f
        var cancelled = false

        override fun cancel() {
            if (cancelled) return
            cancelled = true
            onEnd(false)
        }

        fun at(value: Float) {
            fraction = value
            onFrame(value)
        }

        fun finish() {
            at(1f)
            onEnd(true)
        }
    }

    private class Surface : MotionSurface {
        override var animates = true
        override var motionEnabled = true
        var values = MotionValues()
        var radiusTouched = false
        val renderThread = ArrayList<Pair<Map<MotionChannel, Float>, MotionCurve>>()
        var cancels = 0
        val clocks = ArrayList<Clock>()

        override fun set(values: MotionValues, channels: Set<MotionChannel>) {
            var next = this.values
            for (channel in channels) {
                val value = values.value(channel) ?: continue
                if (channel == MotionChannel.CornerRadius) radiusTouched = true
                next = next.with(channel, value)
            }
            this.values = next
        }

        override fun startRenderThread(targets: Map<MotionChannel, Float>, curve: MotionCurve) {
            renderThread += targets to curve
        }

        override fun cancelRenderThread() {
            cancels += 1
        }

        override fun startClock(durationMillis: Long, onFrame: (Float) -> Unit, onEnd: (Boolean) -> Unit): MotionClock = Clock(durationMillis, onFrame, onEnd).also { clocks += it }
    }

    private val surface = Surface()
    private val ends = ArrayList<Boolean>()
    private val runner = MotionRunner(surface).apply { onEnd = { ends += it } }

    @Test
    fun theFirstValueIsShownWithoutMotionOrAnEnd() {
        runner.show(departed, depart)
        assertTrue(surface.renderThread.isEmpty())
        assertTrue(surface.clocks.isEmpty())
        assertEquals(0f, surface.values.opacity)
        assertEquals(-120f, surface.values.translateY)
        assertTrue(ends.isEmpty())
    }

    @Test
    fun mainsDepartCurveRunsOnTheRenderThreadAndTheEndStateIsKept() {
        runner.show(MotionValues(), depart)
        runner.show(departed, depart)
        val (targets, curve) = surface.renderThread.single()
        assertEquals(mapOf(MotionChannel.Opacity to 0f, MotionChannel.TranslateY to -120f), targets)
        assertEquals("a channel that doesn't change gets no animation", null, targets[MotionChannel.Scale])
        assertEquals(200L, curve.durationMillis)
        assertEquals(listOf(0.2f, 0f, 0f, 1f), (curve as MotionCurve.Timing).controlPoints)
        assertEquals("the render thread starts from where the view is", 1f, surface.values.opacity)
        surface.clocks.single().finish()
        assertEquals("the end state stays once the move ends", 0f, surface.values.opacity)
        assertEquals(-120f, surface.values.translateY)
        assertEquals(listOf(true), ends)
    }

    @Test
    fun anUnnamedCurveIsMainsDefault() {
        assertEquals(listOf(0f, 0f, 0.58f, 1f), MotionCurve.Timing(300, null).controlPoints)
        assertEquals(listOf(0f, 0f, 0.58f, 1f), MotionCurve.Timing(300, listOf(1f, 2f)).controlPoints)
    }

    @Test
    fun mainsSpringTokensBecomeACriticallyDampedSpringThatSettles() {
        val spring = MotionCurve.Spring(0.18, 1.0)
        assertEquals(0.0, spring.progress(0.0), 1e-9)
        var previous = 0.0
        for (step in 1..400) {
            val now = spring.progress(step / 1000.0)
            assertTrue("a critically damped spring never overshoots", now <= 1.0 + 1e-9)
            assertTrue("and never goes back", now + 1e-12 >= previous)
            previous = now
        }
        assertTrue("it settles within 0.1% at its settling time", abs(1 - spring.progress(spring.durationMillis / 1000.0)) <= SpringSolution.SETTLED)
        assertTrue("a critically damped spring settles in about one and a half responses: ${spring.durationMillis} ms", spring.durationMillis in 230L..300L)
        assertEquals(1f, spring.interpolator.getInterpolation(1f))
        val bouncy = MotionCurve.Spring(0.3, 0.5)
        assertTrue("a bouncy spring overshoots", (1..600).any { bouncy.progress(it / 1000.0) > 1.0 })
    }

    private val cardSpring = MotionCurve.Spring(0.3, 1.0)

    private fun pixelsLeftAtTheEnd(travel: Float): Double {
        runner.show(MotionValues(translateY = 0f), cardSpring)
        runner.show(MotionValues(translateY = travel), cardSpring)
        val curve = surface.renderThread.last().second as MotionCurve.Spring
        return (1 - curve.progress(curve.durationMillis / 1000.0)) * travel
    }

    private val nears = ArrayList<Float>()

    private fun nearAt(pixels: Float) {
        runner.nearEndPx = pixels
        runner.onNearEnd = { nears += it }
    }

    @Test
    fun theNearEndFiresOnceWhenTheChosenDistanceIsLeft() {
        nearAt(2f)
        runner.show(MotionValues(translateY = 0f), cardSpring)
        runner.show(MotionValues(translateY = 300f), cardSpring)
        val curve = surface.renderThread.single().second
        val clock = surface.clocks.single()
        val at = MotionRunner.nearFraction(curve, 300f, 2f)
        assertTrue("2 px of 300 comes well before the half-pixel end: $at", at in 0.5f..0.95f)
        clock.at(at - 0.01f)
        assertTrue(nears.isEmpty())
        clock.at(at)
        assertEquals(1, nears.size)
        assertTrue("it reports what is left, in device pixels: ${nears.single()}", nears.single() <= 2f && nears.single() > 0.5f)
        clock.at(at + 0.05f)
        clock.finish()
        assertEquals("once per move", 1, nears.size)
        assertEquals(listOf(true), ends)
    }

    @Test
    fun aMoveShorterThanTheDistanceFiresAtItsStart() {
        nearAt(20f)
        runner.show(MotionValues(translateY = 0f), cardSpring)
        runner.show(MotionValues(translateY = 10f), cardSpring)
        assertEquals(listOf(10f), nears)
    }

    @Test
    fun aSupersededMoveNeverFiresAndTheNewOneFiresForItself() {
        nearAt(2f)
        runner.show(MotionValues(translateY = 0f), cardSpring)
        runner.show(MotionValues(translateY = 300f), cardSpring)
        val first = surface.clocks.single()
        first.at(0.2f)
        runner.show(MotionValues(translateY = 0f), cardSpring)
        first.at(0.99f)
        assertTrue("the old move's frames don't fire it", nears.isEmpty())
        surface.clocks.last().finish()
        assertEquals("the new move fires by its end at the latest", 1, nears.size)
    }

    @Test
    fun withMotionOffTheNearEndComesWithTheEnd() {
        nearAt(2f)
        runner.show(MotionValues(translateY = 0f), cardSpring)
        surface.animates = false
        runner.show(MotionValues(translateY = 300f), cardSpring)
        assertEquals(listOf(0f), nears)
        assertEquals(listOf(true), ends)
    }

    @Test
    fun withoutADistanceNothingFires() {
        runner.onNearEnd = { nears += it }
        runner.show(MotionValues(translateY = 0f), cardSpring)
        runner.show(MotionValues(translateY = 300f), cardSpring)
        surface.clocks.single().finish()
        assertTrue(nears.isEmpty())
    }

    @Test
    fun aSpringEndsOnceLessThanHalfADevicePixelIsLeft() {
        val left = pixelsLeftAtTheEnd(300f)
        val curve = surface.renderThread.last().second as MotionCurve.Spring
        assertTrue("half a pixel or less is left for the last frame's snap: $left", left <= 0.5)
        assertTrue("a millisecond sooner more than half a pixel is left", (1 - curve.progress((curve.durationMillis - 2) / 1000.0)) * 300 > 0.5)
        assertTrue("the card's 300 px growth ends near 410 ms, not the spring's 0.1% at ${cardSpring.durationMillis}: ${curve.durationMillis}", curve.durationMillis in 395L..425L)
        assertTrue(curve.durationMillis < cardSpring.durationMillis)
    }

    @Test
    fun aLongerMoveTakesLongerToComeWithinHalfAPixel() {
        val short = pixelsLeftAtTheEnd(100f).let { surface.renderThread.last().second.durationMillis }
        val long = pixelsLeftAtTheEnd(2000f).let { surface.renderThread.last().second.durationMillis }
        assertTrue("$short < $long", short < long)
        assertTrue("a 2000 px move needs more than the spring's 0.1%", long > cardSpring.durationMillis)
    }

    @Test
    fun aTinyMoveStillRunsItsSpringUntilWithinTwoPercent() {
        pixelsLeftAtTheEnd(5f)
        assertEquals(MotionCurve.Spring(0.3, 1.0, SpringSolution.SETTLED_AT_MOST).durationMillis, surface.renderThread.last().second.durationMillis)
    }

    @Test
    fun aTimingCurveIsNotFittedToTheMove() {
        runner.show(MotionValues(), depart)
        runner.show(departed, depart)
        assertEquals(depart, surface.renderThread.single().second)
    }

    @Test
    fun theCardsCornersGrowWithTheSameCurveBesideTheRenderThreadMove() {
        runner.show(MotionValues(scale = 0.8f, cornerRadius = 28f), expand)
        assertEquals(28f, surface.values.cornerRadius)
        runner.show(MotionValues(scale = 1f, cornerRadius = 55f), expand)
        val (targets, fitted) = surface.renderThread.single()
        assertEquals("the corners can't run on the render thread, so the clock moves them", mapOf(MotionChannel.Scale to 1f), targets)
        val clock = surface.clocks.single()
        assertEquals("the corners and the render thread share one curve", fitted.durationMillis, clock.durationMillis)
        clock.at(0.5f)
        val half = 28f + (55f - 28f) * fitted.interpolator.getInterpolation(0.5f)
        assertEquals(half, surface.values.cornerRadius!!, 0.001f)
        clock.finish()
        assertEquals(55f, surface.values.cornerRadius)
        assertEquals("the end waits for the corners too", listOf(true), ends)
    }

    @Test
    fun leavingOutTheCornersNeverTouchesTheViewsOwn() {
        runner.show(MotionValues(), depart)
        runner.show(departed, depart)
        surface.clocks.single().finish()
        assertTrue(!surface.radiusTouched)
        assertNull(surface.values.cornerRadius)
    }

    @Test
    fun theEndFiresOnceWhenTheMoveHasStopped() {
        runner.show(MotionValues(), depart)
        runner.show(departed, depart)
        assertTrue(ends.isEmpty())
        val clock = surface.clocks.single()
        clock.finish()
        assertEquals(listOf(true), ends)
        clock.onEnd(true)
        assertEquals("a late stop doesn't fire it again", listOf(true), ends)
    }

    @Test
    fun aSupersededMoveReportsNothingAndTheNewOneStartsFromWhereTheViewIs() {
        runner.show(MotionValues(), depart)
        runner.show(departed, depart)
        val old = surface.clocks.single()
        old.at(0.5f)
        val shownAtHalf = 1f + (0f - 1f) * depart.interpolator.getInterpolation(0.5f)
        runner.show(MotionValues(opacity = 1f, translateY = -60f), depart)
        assertTrue("the old clock was stopped", old.cancelled)
        assertEquals(1, surface.cancels)
        assertTrue("the old move's end is never reported", ends.isEmpty())
        assertEquals("the new move starts from the presentation value", shownAtHalf, surface.values.opacity, 0.001f)
        surface.clocks.last().finish()
        assertEquals(listOf(true), ends)
    }

    @Test
    fun withoutMotionTheEndStateLandsAtOnceAndReportsFinished() {
        runner.show(MotionValues(), depart)
        surface.animates = false
        runner.show(departed, depart)
        assertTrue(surface.renderThread.isEmpty())
        assertEquals(0f, surface.values.opacity)
        assertEquals(listOf(true), ends)
    }

    @Test
    fun theSameTargetAgainDoesNothing() {
        runner.show(MotionValues(), depart)
        runner.show(departed, depart)
        val move = runner.move
        runner.show(departed, depart)
        assertEquals(move, runner.move)
        assertTrue(ends.isEmpty())
    }

    private val cardPose = MotionValues(translateY = 140f, scale = 0.69f, cornerRadius = 28f)
    private val fullPose = MotionValues(scale = 1f, cornerRadius = 55f)

    @Test
    fun aStartPoseMovesToTheTargetInTheSameMountBeforeTheViewIsInAWindow() {
        surface.animates = false
        runner.show(fullPose, expand, start = cardPose)
        val (targets, curve) = surface.renderThread.single()
        assertEquals(mapOf(MotionChannel.TranslateY to 0f, MotionChannel.Scale to 1f), targets)
        assertEquals(expand.response, (curve as MotionCurve.Spring).response, 0.0)
        assertEquals(expand.dampingFraction, curve.dampingFraction, 0.0)
        assertEquals("the start pose is shown first", 0.69f, surface.values.scale)
        assertEquals(140f, surface.values.translateY)
        assertEquals(28f, surface.values.cornerRadius)
        surface.clocks.single().finish()
        assertEquals(fullPose.copy(), surface.values)
        assertEquals("its end is reported like any other move's", listOf(true), ends)
    }

    @Test
    fun aStartPoseCountsOnlyAtTheFirstMountAndOneEqualToTheTargetDoesntMove() {
        runner.show(fullPose, expand, start = fullPose)
        assertTrue(surface.renderThread.isEmpty())
        assertTrue(ends.isEmpty())
        runner.show(cardPose, expand, start = MotionValues(scale = 0.2f))
        val (targets, _) = surface.renderThread.single()
        assertEquals("a later move starts from where the view is, not from a start pose", 1f, surface.values.scale)
        assertEquals(0.69f, targets[MotionChannel.Scale])
    }

    @Test
    fun withMotionOffAStartPoseJumpsToTheTargetAndReportsTheEnd() {
        surface.motionEnabled = false
        runner.show(fullPose, expand, start = cardPose)
        assertTrue(surface.renderThread.isEmpty())
        assertEquals(1f, surface.values.scale)
        assertEquals(55f, surface.values.cornerRadius)
        assertEquals(listOf(true), ends)
    }

    @Test
    fun leavingTheWindowMidMoveLandsWhereItWasAndReportsUnfinished() {
        runner.show(MotionValues(), depart)
        runner.show(departed, depart)
        surface.clocks.single().at(0.5f)
        runner.interrupt()
        assertEquals(listOf(false), ends)
        runner.interrupt()
        assertEquals(listOf(false), ends)
    }
}
