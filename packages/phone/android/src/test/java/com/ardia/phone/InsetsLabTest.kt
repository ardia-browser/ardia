package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class InsetsLabTest {
    @Test
    fun theLineNamesEveryValueAPhoneRunMatchesAgainstTheDecksShift() {
        val line = InsetsLab.line(InsetsLab.Reading(barsTop = 68, barsBottom = 66, contentTop = 0, contentHeight = 2400, rootTop = 0, rootHeight = 2400, windowHeight = 2400, night = true))
        assertEquals("PAGELAB window insets top/bottom 68/66, content top 0 height 2400, react root top 0 height 2400, window height 2400, night", line)
    }
}
