package com.ardia.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PageMotionTest {
    @Test
    fun progressPublishesWholePercentsAtMostEveryHundredMilliseconds() {
        val throttle = ProgressThrottle()
        assertEquals(0.1f, throttle.offer(0.104, 1_000)!!, 0f)
        assertNull(throttle.offer(0.109, 1_200))
        assertNull(throttle.offer(0.3, 1_050))
        assertEquals(0.3f, throttle.offer(0.3, 1_100)!!, 0f)
    }

    @Test
    fun progressAlwaysPublishesTheFinish() {
        val throttle = ProgressThrottle()
        throttle.offer(0.5, 1_000)
        assertEquals(1f, throttle.offer(1.4, 1_001)!!, 0f)
        throttle.reset()
        assertEquals(0f, throttle.published, 0f)
        assertEquals(0.2f, throttle.offer(0.2, 1_002)!!, 0f)
    }

    @Test
    fun scrollingDownPastTheThresholdTurnsDown() {
        val tracker = ScrollDirectionTracker()
        assertNull(tracker.offer(10.0, atEnd = false, nowMillis = 0))
        assertEquals(ScrollDirection.Down, tracker.offer(30.0, atEnd = false, nowMillis = 0))
        assertNull(tracker.offer(200.0, atEnd = false, nowMillis = 0))
    }

    @Test
    fun scrollingBackUpPastTheThresholdTurnsUp() {
        val tracker = ScrollDirectionTracker()
        tracker.offer(100.0, atEnd = false, nowMillis = 0)
        tracker.offer(400.0, atEnd = false, nowMillis = 0)
        assertNull(tracker.offer(390.0, atEnd = false, nowMillis = 0))
        assertEquals(ScrollDirection.Up, tracker.offer(360.0, atEnd = false, nowMillis = 0))
    }

    @Test
    fun theBottomBounceDoesNotFlipDirection() {
        val tracker = ScrollDirectionTracker()
        tracker.offer(600.0, atEnd = false, nowMillis = 0)
        assertEquals(ScrollDirection.Down, tracker.direction)
        assertNull(tracker.offer(1_200.0, atEnd = true, nowMillis = 0))
        assertNull(tracker.offer(1_190.0, atEnd = true, nowMillis = 0))
        assertEquals(ScrollDirection.Down, tracker.direction)
    }

    @Test
    fun reachingTheBottomFromTheTopTurnsDown() {
        val tracker = ScrollDirectionTracker()
        assertNull(tracker.offer(0.0, atEnd = false, nowMillis = 0))
        assertEquals(ScrollDirection.Down, tracker.offer(600.0, atEnd = true, nowMillis = 16))
        assertNull(tracker.offer(556.0, atEnd = true, nowMillis = 32))
        assertEquals(ScrollDirection.Down, tracker.direction)
    }

    @Test
    fun creepingOntoTheBottomTurnsDownOncePastTheThreshold() {
        val tracker = ScrollDirectionTracker()
        assertNull(tracker.offer(20.0, atEnd = true, nowMillis = 0))
        assertEquals(ScrollDirection.Down, tracker.offer(30.0, atEnd = true, nowMillis = 16))
    }

    @Test
    fun aResizeMovingThePageOntoTheBottomDoesNotTurnDown() {
        val tracker = ScrollDirectionTracker()
        tracker.resized(1_000)
        assertNull(tracker.offer(600.0, atEnd = true, nowMillis = 1_016))
        assertNull(tracker.offer(600.0, atEnd = true, nowMillis = 2_100))
        assertEquals(ScrollDirection.Up, tracker.direction)
    }

    @Test
    fun theBarResizingThePageAtTheBottomDoesNotFlipDirection() {
        val tracker = ScrollDirectionTracker()
        assertEquals(ScrollDirection.Down, tracker.offer(600.0, atEnd = false, nowMillis = 0))
        assertNull(tracker.offer(1_200.0, atEnd = false, nowMillis = 100))
        var now = 1_000L
        repeat(3) {
            tracker.resized(now)
            assertNull(tracker.offer(1_156.0, atEnd = false, nowMillis = now + 16))
            now += 370
            tracker.resized(now)
            assertNull(tracker.offer(1_200.0, atEnd = false, nowMillis = now + 16))
            now += 370
        }
        assertEquals(ScrollDirection.Down, tracker.direction)
    }

    @Test
    fun aLateLayoutScrollAfterAResizeDoesNotFlipDirection() {
        val tracker = ScrollDirectionTracker()
        assertEquals(ScrollDirection.Down, tracker.offer(600.0, atEnd = false, nowMillis = 0))
        tracker.resized(1_000)
        assertNull(tracker.offer(1_199.0, atEnd = false, nowMillis = 1_016))
        assertNull(tracker.offer(1_156.0, atEnd = false, nowMillis = 1_200))
        assertEquals(ScrollDirection.Down, tracker.direction)
    }

    @Test
    fun aGestureRightAfterAQuietResizeStillTurns() {
        val tracker = ScrollDirectionTracker()
        assertEquals(ScrollDirection.Down, tracker.offer(600.0, atEnd = false, nowMillis = 0))
        tracker.resized(1_000)
        tracker.touched(1_000.0)
        assertNull(tracker.offer(590.0, atEnd = false, nowMillis = 1_050))
        assertEquals(ScrollDirection.Up, tracker.offer(570.0, atEnd = false, nowMillis = 1_066))
    }

    @Test
    fun reversingASwipeThatSawAResizeTurnsUp() {
        val tracker = ScrollDirectionTracker()
        assertEquals(ScrollDirection.Down, tracker.offer(600.0, atEnd = false, nowMillis = 0))
        tracker.touched(1_000.0)
        tracker.dragged(900.0)
        tracker.resized(1_000)
        tracker.dragged(940.0)
        assertNull(tracker.offer(590.0, atEnd = false, nowMillis = 1_016))
        assertEquals(ScrollDirection.Up, tracker.offer(570.0, atEnd = false, nowMillis = 1_032))
    }

    @Test
    fun aSwipeThatSawAResizeTurnsDownAtTheBottom() {
        val tracker = ScrollDirectionTracker()
        tracker.touched(1_000.0)
        tracker.resized(1_000)
        tracker.dragged(900.0)
        assertEquals(ScrollDirection.Down, tracker.offer(100.0, atEnd = true, nowMillis = 1_016))
    }

    @Test
    fun aResizeUnderARestingFingerDoesNotFlipDirection() {
        val tracker = ScrollDirectionTracker()
        assertEquals(ScrollDirection.Down, tracker.offer(1_200.0, atEnd = false, nowMillis = 0))
        tracker.touched(1_000.0)
        tracker.resized(1_000)
        tracker.dragged(1_010.0)
        assertNull(tracker.offer(1_156.0, atEnd = false, nowMillis = 1_016))
        assertEquals(ScrollDirection.Down, tracker.direction)
    }

    @Test
    fun aResizeMovingThePageAgainstTheSwipeDoesNotFlipDirection() {
        val tracker = ScrollDirectionTracker()
        assertEquals(ScrollDirection.Down, tracker.offer(1_200.0, atEnd = false, nowMillis = 0))
        tracker.touched(1_000.0)
        tracker.resized(1_000)
        tracker.dragged(900.0)
        assertNull(tracker.offer(1_156.0, atEnd = false, nowMillis = 1_016))
        assertEquals(ScrollDirection.Down, tracker.direction)
    }

    @Test
    fun aResizeAfterASwipeEndsDoesNotFlipDirection() {
        val tracker = ScrollDirectionTracker()
        assertEquals(ScrollDirection.Down, tracker.offer(1_200.0, atEnd = false, nowMillis = 0))
        tracker.touched(1_000.0)
        tracker.dragged(1_100.0)
        tracker.resized(1_000)
        assertNull(tracker.offer(1_156.0, atEnd = false, nowMillis = 1_016))
        assertEquals(ScrollDirection.Down, tracker.direction)
    }

    @Test
    fun releasingAfterADragDuringResizeSettleRestoresResizeProtection() {
        val tracker = ScrollDirectionTracker()
        assertEquals(ScrollDirection.Down, tracker.offer(1_200.0, atEnd = false, nowMillis = 0))
        tracker.touched(1_000.0)
        tracker.resized(1_000)
        tracker.dragged(1_040.0)
        assertNull(tracker.offer(1_190.0, atEnd = false, nowMillis = 1_016))
        tracker.released()
        assertNull(tracker.offer(1_156.0, atEnd = false, nowMillis = 1_050))
        assertEquals(ScrollDirection.Down, tracker.direction)
    }

    @Test
    fun scrollingWithoutTouchTracksAgainOnceTheResizeSettles() {
        val tracker = ScrollDirectionTracker()
        assertEquals(ScrollDirection.Down, tracker.offer(600.0, atEnd = false, nowMillis = 0))
        tracker.resized(1_000)
        assertNull(tracker.offer(560.0, atEnd = false, nowMillis = 1_500))
        assertNull(tracker.offer(550.0, atEnd = false, nowMillis = 2_000))
        assertEquals(ScrollDirection.Up, tracker.offer(520.0, atEnd = false, nowMillis = 2_016))
    }

    @Test
    fun theTopAlwaysMeansUp() {
        val tracker = ScrollDirectionTracker()
        tracker.offer(600.0, atEnd = false, nowMillis = 0)
        assertEquals(ScrollDirection.Up, tracker.offer(0.0, atEnd = false, nowMillis = 0))
    }

    @Test
    fun snapToPreservesUpAndSetsAnchorAtRestoredOffset() {
        val tracker = ScrollDirectionTracker()
        tracker.offer(600.0, atEnd = false, nowMillis = 0)
        assertEquals(ScrollDirection.Down, tracker.direction)

        tracker.snapTo(1_000.0)
        assertEquals(ScrollDirection.Up, tracker.direction)

        assertNull(tracker.offer(1_000.0, atEnd = false, nowMillis = 0))
        assertEquals(ScrollDirection.Up, tracker.direction)

        assertEquals(ScrollDirection.Down, tracker.offer(1_030.0, atEnd = false, nowMillis = 0))
    }

    @Test
    fun zoomStepsThroughTheIphoneLevels() {
        assertEquals(1.15, PageZoom.next(1.0)!!, 0.0)
        assertEquals(0.85, PageZoom.previous(1.0)!!, 0.0)
        assertNull(PageZoom.next(3.0))
        assertNull(PageZoom.previous(0.5))
        assertEquals(3.0, PageZoom.clamp(9.0), 0.0)
        assertEquals(0.5, PageZoom.clamp(0.1), 0.0)
    }
}
