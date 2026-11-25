package com.ardia.phone

import com.ardia.sync.SyncJoin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanFeedTest {
    @Test
    fun aGeneratedCodeGoesThroughTheScannersOwnDecoder() {
        val phrase = ScanFeed.throwawayPhrase()
        assertTrue(SyncJoin.check(phrase).isValid)
        assertEquals(phrase, ScanFeed.decodeAsCamera(phrase))
        assertEquals("https://example.com/not-a-phrase", ScanFeed.decodeAsCamera("https://example.com/not-a-phrase"))
    }

    @Test
    fun codesTheSingleCodeReaderMissesStillScan() {
        val phrases = listOf(
            "twin matrix tomorrow group portion guard canyon animal argue tone love blanket jeans misery pulse duty title riot gold million fitness brain aerobic flame",
            "razor rather analyst tuna sing depend shiver cable since welcome wood tank much toast flip afraid miss ordinary because soap place subject exhaust sweet",
            "other forward divide infant provide main bike chest quote scan pill now physical hard mirror tortoise best jacket stumble jacket reject wash age object",
            "snake razor option guess fit vibrant this inherit witness travel rocket ladder parent grain spend else kiss stuff stumble step inquiry sure wagon ahead",
            "mansion sibling source build now foam arrange make junk myth insect canoe inflict leader moment cabbage clutch early hero head north boat rebel mimic",
            "begin that surprise gas corn chuckle laugh wave rice scatter alone juice point bean calm cat narrow illegal cherry smoke insane slush attitude ensure",
        )
        for (phrase in phrases) {
            assertTrue(phrase, SyncJoin.check(phrase).isValid)
            assertEquals(phrase, ScanFeed.decodeAsCamera(phrase))
        }
    }
}
