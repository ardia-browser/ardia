package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class FrostRefreshTest {
    @Test
    fun overAStillPageTheFrostRefreshesAFewTimesASecondNotEveryFrame() {
        assertEquals(FrostRefresh.IDLE_MILLIS, FrostRefresh.next(holdsPage = true, millisSinceScroll = 5_000L))
        assertEquals(FrostRefresh.IDLE_MILLIS, FrostRefresh.next(holdsPage = true, millisSinceScroll = FrostRefresh.AFTER_SCROLL_MILLIS))
    }

    @Test
    fun whileThePageUnderItScrollsTheFrostFollowsEveryFrame() {
        assertEquals(0L, FrostRefresh.next(holdsPage = true, millisSinceScroll = 0L))
        assertEquals(0L, FrostRefresh.next(holdsPage = true, millisSinceScroll = FrostRefresh.AFTER_SCROLL_MILLIS - 1))
    }

    @Test
    fun withoutAPageUnderItTheFrostRedrawsOnlyWhenItsSourceDoes() {
        assertEquals(null, FrostRefresh.next(holdsPage = false, millisSinceScroll = 0L))
    }

    @Test
    fun eachFrostIsNamedInTheLogByItsNameOrItsSourceVariantAndNumber() {
        assertEquals("deck-plus", FrostRefresh.label(name = "deck-plus", source = "deck", variant = "bar", number = 3))
        assertEquals("deck/bar #3", FrostRefresh.label(name = null, source = "deck", variant = null, number = 3))
        assertEquals("-/sheet #1", FrostRefresh.label(name = "", source = null, variant = "sheet", number = 1))
    }
}
