package com.ardia.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShownPageTest {
    @Test
    fun pageCountsAsShownOnlyWhileTheActivityIsInFront() {
        val shown = ShownPage()
        shown.enterFront()
        shown.show("a")
        assertTrue(shown.isShown("a"))
        shown.leaveFront()
        assertFalse(shown.isShown("a"))
    }

    @Test
    fun pageNamedWhileTheActivityIsAwayIsRecoveredOnlyWhenItComesBack() {
        val shown = ShownPage()
        shown.enterFront()
        shown.leaveFront()
        assertNull(shown.show("a"))
        assertFalse(shown.isShown("a"))
        assertEquals("a", shown.enterFront())
        assertTrue(shown.isShown("a"))
    }

    @Test
    fun comingBackHandsOverTheShownPageOnce() {
        val shown = ShownPage()
        assertNull(shown.enterFront())
        assertEquals("a", shown.show("a"))
        assertNull(shown.show("a"))
        shown.leaveFront()
        assertEquals("a", shown.enterFront())
        assertNull(shown.enterFront())
    }

    @Test
    fun noPageIsShownBeforeTheActivityComesToTheFront() {
        val shown = ShownPage()
        assertNull(shown.show("a"))
        assertFalse(shown.isShown("a"))
    }
}
