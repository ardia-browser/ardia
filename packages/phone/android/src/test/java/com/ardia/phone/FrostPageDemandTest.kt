package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class FrostPageDemandTest {
    private fun overPage(sourceHasContent: Boolean, pageMode: FrostSources.PageMode) = FrostPage.choose(
        blurSupported = true,
        reduceTransparency = false,
        hasSource = true,
        sourceHasContent = sourceHasContent,
        hardware = true,
        insideSource = false,
        holdsPage = true,
        pageMode = pageMode,
    )

    @Test
    fun aFrostOverAPageInSolidModeIsSolidBeforeAndAfterTheSourceRecords() {
        assertEquals(FrostPage.Path.Solid, overPage(sourceHasContent = false, pageMode = FrostSources.PageMode.Solid).path)
        assertEquals(FrostPage.Path.Solid, overPage(sourceHasContent = true, pageMode = FrostSources.PageMode.Solid).path)
    }

    @Test
    fun aFrostNeverAsksAPageSourceToRecordInSolidMode() {
        val solid = FrostSources.PageMode.Solid
        val waiting = FrostPage.Choice(FrostPage.Path.Fallback, FrostPage.SOURCE_NOT_DRAWN)
        assertEquals(false, FrostPage.wantsSource(null, onlyBackdropUnder = false, blurOverBackdrop = false, holdsPage = true, pageMode = solid))
        assertEquals(false, FrostPage.wantsSource(waiting, onlyBackdropUnder = false, blurOverBackdrop = false, holdsPage = true, pageMode = solid))
        assertEquals(true, FrostPage.wantsSource(waiting, onlyBackdropUnder = false, blurOverBackdrop = false, holdsPage = true, pageMode = FrostSources.PageMode.Live))
        assertEquals(true, FrostPage.wantsSource(null, onlyBackdropUnder = false, blurOverBackdrop = false, holdsPage = false, pageMode = solid))
        assertEquals(false, FrostPage.wantsSource(null, onlyBackdropUnder = true, blurOverBackdrop = false, holdsPage = false, pageMode = solid))
    }

    @Test
    fun aLivePageStillWaitsForItsSourceToRecord() {
        assertEquals(FrostPage.SOURCE_NOT_DRAWN, overPage(sourceHasContent = false, pageMode = FrostSources.PageMode.Live).reason)
        assertEquals(FrostPage.Path.Live, overPage(sourceHasContent = true, pageMode = FrostSources.PageMode.Live).path)
    }
}
