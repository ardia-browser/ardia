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
}
