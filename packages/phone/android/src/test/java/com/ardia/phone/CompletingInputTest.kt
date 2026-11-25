package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CompletingInputTest {
    private val input = CompletingInput().apply { focus(true) }

    private fun type(text: String) = input.edit(text, text.length, text.length, -1, -1)

    @Test
    fun anOfferForTheTypedTextShowsTheRestAsASuffixAndSubmitsTheWhole() {
        assertTrue(type("goo").typedChanged)
        assertTrue(input.offer("goo", "google.com"))
        assertEquals("gle.com", input.suffix)
        assertEquals("google.com", input.displayed)
        assertFalse("an offer for other text changes nothing", input.offer("gi", "github.com"))
        assertEquals("gle.com", input.suffix)
    }

    @Test
    fun typingWhatTheSuffixStartsWithMovesItIntoTheTypedTextOtherwiseDropsIt() {
        type("goo")
        input.offer("goo", "google.com")
        val consumed = type("goog")
        assertTrue(consumed.typedChanged)
        assertEquals("le.com", input.suffix)
        assertEquals("goog", consumed.text)
        type("googx")
        assertEquals("", input.suffix)
    }

    @Test
    fun backspaceWithASuffixRemovesOnlyTheSuffixAndHoldsNewOnesUntilTheNextInsert() {
        type("goo")
        input.offer("goo", "google.com")
        val deleted = input.edit("go", 2, 2, -1, -1)
        assertEquals("the field keeps what was typed", "goo", deleted.text)
        assertEquals(3, deleted.selectionStart)
        assertFalse(deleted.typedChanged)
        assertEquals("", input.suffix)
        assertFalse(input.offer("goo", "google.com"))
        assertEquals("", input.suffix)
        type("goog")
        input.offer("goog", "google.com")
        assertEquals("le.com", input.suffix)
    }

    @Test
    fun movingTheCaretAwayFromTheEndAcceptsTheSuffix() {
        type("goo")
        input.offer("goo", "google.com")
        val moved = input.edit("goo", 1, 1, -1, -1)
        assertEquals("google.com", moved.text)
        assertTrue(moved.typedChanged)
        assertEquals("", input.suffix)
    }

    @Test
    fun aComposingSpanOfCjkTextDropsTheSuffixAndBlocksOffers() {
        type("w")
        input.offer("w", "wikipedia.org")
        assertEquals("ikipedia.org", input.suffix)
        input.edit("w日", 2, 2, 1, 2)
        assertEquals("", input.suffix)
        assertFalse(input.offer("w日", "w日本.jp"))
    }

    @Test
    fun losingFocusDropsTheSuffixAndOffersWaitForFocus() {
        type("goo")
        input.offer("goo", "google.com")
        assertTrue(input.focus(false))
        assertEquals("", input.suffix)
        assertFalse(input.offer("goo", "google.com"))
    }

    @Test
    fun settingTheTextReplacesItWithOptionalSelectAll() {
        type("goo")
        val set = input.reset("ardia.dev", selectsAll = true)
        assertEquals(0, set.selectionStart)
        assertEquals(9, set.selectionEnd)
        assertEquals("ardia.dev", input.typed)
    }
}
