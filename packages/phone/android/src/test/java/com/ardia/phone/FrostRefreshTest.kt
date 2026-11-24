package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class FrostRefreshTest {
    @Test
    fun eachFrostIsNamedInTheLogByItsNameOrItsSourceVariantAndNumber() {
        assertEquals("deck-plus", FrostRefresh.label(name = "deck-plus", source = "deck", variant = "bar", number = 3))
        assertEquals("deck/bar #3", FrostRefresh.label(name = null, source = "deck", variant = null, number = 3))
        assertEquals("-/sheet #1", FrostRefresh.label(name = "", source = null, variant = "sheet", number = 1))
    }
}
