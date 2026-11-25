package com.ardia.phone

import android.content.Context
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LookCostTest {
    private val app: Context = RuntimeEnvironment.getApplication()

    @After
    fun reset() {
        LookSwitch.forgetForTests()
        LookPaint.forgetCaches()
    }

    @Test
    fun theBlobFrameRateIsALabSwitchThatLastsAndDefaultsToPaced() {
        assertEquals(LookRules.PACED, LookSwitch.blobFramesPerSecond(app, lab = true))
        LookSwitch.setBlobFramesPerSecond(app, 30, lab = true)
        LookSwitch.forgetForTests()
        assertEquals(30, LookSwitch.blobFramesPerSecond(app, lab = true))
        LookSwitch.setBlobFramesPerSecond(app, LookRules.EVERY_FRAME, lab = true)
        assertEquals(LookRules.EVERY_FRAME, LookSwitch.blobFramesPerSecond(app, lab = true))
        assertEquals("a store build is always paced", LookRules.PACED, LookSwitch.blobFramesPerSecond(app, lab = false))
        assertThrows(IllegalStateException::class.java) { LookSwitch.setBlobFramesPerSecond(app, 20, lab = false) }
        LookSwitch.setBlobFramesPerSecond(app, 0, lab = true)
    }

    @Test
    fun pacedBlobsRedrawWhenTheFastestHasMovedOnePercentOfItsRadius() {
        val pace = LookRules.blobPaceMillis(1080f, 2400f)
        val radius = LookRules.blobRadius(1080f, 2400f)
        var fastest = 0f
        for (index in 0 until 3) {
            val start = LookRules.blobCenter(index, 0f, 1080f, 2400f)
            val angle = (2 * Math.PI * pace / com.ardia.design.TabsBackdropMotion.loopsMillis[index]).toFloat()
            val moved = LookRules.blobCenter(index, angle, 1080f, 2400f)
            fastest = maxOf(fastest, Math.hypot((moved.first - start.first).toDouble(), (moved.second - start.second).toDouble()).toFloat())
        }
        assertEquals(radius * LookRules.BLOB_STEP_SHARE, fastest, radius * LookRules.BLOB_STEP_SHARE * 0.1f)
        assertTrue("a 1080x2400 deck is paced near 25 fps, not every frame: $pace ms", pace in 30L..50L)
        assertEquals(0L, LookRules.nextBlobFrameMillis(LookRules.EVERY_FRAME, 1080f, 2400f))
        assertEquals(33L, LookRules.nextBlobFrameMillis(30, 1080f, 2400f))
        assertEquals(pace, LookRules.nextBlobFrameMillis(LookRules.PACED, 1080f, 2400f))
    }

    @Test
    fun theBlobsHoldStillWhileSomethingElseDrawsAndMoveOnAfterASecondOfQuiet() {
        val now = 10_000L
        assertFalse("nothing but the blobs has drawn", LookRules.othersMovedRecently(0L, now))
        assertTrue("a frame someone else asked for, just now", LookRules.othersMovedRecently(now - 16, now))
        assertTrue("between two swipes 600 ms apart the blobs stay still", LookRules.othersMovedRecently(now - 600, now))
        assertFalse("a second after the last foreign frame they move on", LookRules.othersMovedRecently(now - 1_000, now))
    }

    @Test
    fun aFrostBlursSmallEnoughThatSkiaBlursItInOnePassWhereItCan() {
        assertEquals(8f, FrostScale.of(30f * 2.75f))
        assertEquals(8f, FrostScale.of(20f * 2.75f))
        assertEquals("the glass's 12 dp: 5.5 px in the small layer, a sigma under Skia's 4", 6f, FrostScale.of(12f * 2.75f))
        assertEquals(1f, FrostScale.of(4f))
        assertTrue(12f * 2.75f / FrostScale.of(12f * 2.75f) <= FrostScale.MAX_LOW_RES_BLUR)
        assertTrue("a big frost is capped at an eighth", 30f * 2.75f / FrostScale.of(30f * 2.75f) > FrostScale.MAX_LOW_RES_BLUR)
    }

    @Test
    fun aFrostOverAPageIsSolidUnlessTheLabAsksForLive() {
        assertEquals(FrostSources.PageMode.Solid, FrostSources.pageMode)
    }

    @Test
    fun theBlobCentreWithoutAllocatingIsTheComposeFormula() {
        val out = FloatArray(2)
        for (index in 0 until 3) {
            for (angle in listOf(0f, 1.1f, 3.9f)) {
                val (x, y) = LookRules.blobCenter(index, angle, 1080f, 2400f)
                LookRules.blobCenterInto(index, angle, 1080f, 2400f, out)
                assertEquals(x, out[0], 0.001f)
                assertEquals(y, out[1], 0.001f)
            }
        }
    }

    @Test
    fun theGrainPaintIsMadeOncePerDensityAndOpacityAndDroppedOnATrim() {
        val first = LookPaint.grain(2.75f, 0.08f)
        assertSame(first, LookPaint.grain(2.75f, 0.08f))
        assertNotSame(first, LookPaint.grain(2.75f, 0.06f))
        LookPaint.forgetCaches()
        assertNotSame(first, LookPaint.grain(2.75f, 0.08f))
    }

    @Test
    fun aSecondSubmitOfTheSameTextWithinOnePressIsDropped() {
        val first = SubmitOnce.Submit("google.com", 1_000L)
        assertTrue(SubmitOnce.isRepeat(first, "google.com", 1_000L + 120L))
        assertFalse("another text is a new submit", SubmitOnce.isRepeat(first, "github.com", 1_000L + 120L))
        assertFalse("a later press is a new submit", SubmitOnce.isRepeat(first, "google.com", 1_000L + SubmitOnce.WINDOW_MILLIS))
        assertFalse(SubmitOnce.isRepeat(null, "google.com", 1_000L))
    }
}
