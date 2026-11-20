package com.ardia.phone

import android.content.Context
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PageTranslationTest {
    private fun store(system: String = "en") = PhoneTranslation(RuntimeEnvironment.getApplication().getSharedPreferences("translation-test", Context.MODE_PRIVATE).apply { edit().clear().commit() }) { system }

    @Test
    fun startUrlCarriesTheChosenLanguage() {
        val url = PageTranslation.url("https://example.com/a?b=1", "fr")
        assertTrue(url.startsWith("https://translate.google.com/translate?"))
        assertEquals("fr", PageTranslation.chosenLanguage(url))
        assertTrue(url.contains("u=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1"))
    }

    @Test
    fun readsTheLanguagePickedOnGooglesPage() {
        assertEquals("de", PageTranslation.chosenLanguage("https://example-com.translate.goog/a?b=1&_x_tr_sl=auto&_x_tr_tl=de&_x_tr_hl=en&_x_tr_pto=wapp"))
        assertEquals("zh-TW", PageTranslation.chosenLanguage("https://example-com.translate.goog/?_x_tr_tl=zh-TW"))
    }

    @Test
    fun ignoresPagesThatAreNotATranslation() {
        assertNull(PageTranslation.chosenLanguage("https://example.com/?tl=fr&_x_tr_tl=fr"))
        assertNull(PageTranslation.chosenLanguage("https://translate.google.com/?tl=fr"))
        assertNull(PageTranslation.chosenLanguage("https://example-com.translate.goog/?_x_tr_tl=auto"))
        assertNull(PageTranslation.chosenLanguage("https://example-com.translate.goog/?_x_tr_tl=%3Cscript%3E"))
        assertNull(PageTranslation.chosenLanguage("not a url"))
    }

    @Test
    fun systemLanguageKeepsChineseScripts() {
        assertEquals("en", PageTranslation.systemLanguage(listOf(Locale.forLanguageTag("en-US"))))
        assertEquals("zh-TW", PageTranslation.systemLanguage(listOf(Locale.forLanguageTag("zh-Hant-TW"))))
        assertEquals("zh-CN", PageTranslation.systemLanguage(listOf(Locale.forLanguageTag("zh-Hans-CN"))))
        assertEquals("en", PageTranslation.systemLanguage(emptyList()))
    }

    @Test
    fun namesTheLanguageInTheReadersLocale() {
        assertEquals("German", PageTranslation.displayName("de", Locale.US))
        assertEquals("allemand", PageTranslation.displayName("de", Locale.FRANCE))
    }

    @Test
    fun remembersTheLastLanguageAndTheConsentButNothingFromPrivateTabs() {
        val first = store(system = "en")
        assertNull(first.language)
        assertFalse(first.confirmed)
        assertEquals("en", first.target)
        first.remember("https://example-com.translate.goog/?_x_tr_tl=ja", isPrivate = true)
        assertNull(first.language)
        first.remember("https://example-com.translate.goog/?_x_tr_tl=ja", isPrivate = false)
        first.remember("https://example.com/", isPrivate = false)
        first.confirmed = true
        val relaunched = PhoneTranslation(RuntimeEnvironment.getApplication().getSharedPreferences("translation-test", Context.MODE_PRIVATE)) { "en" }
        assertEquals("ja", relaunched.target)
        assertTrue(relaunched.confirmed)
        assertEquals("ja", PageTranslation.chosenLanguage(relaunched.url("https://example.com/")))
        assertEquals(mapOf("language" to "ja", "languageName" to PageTranslation.displayName("ja"), "confirmed" to true), relaunched.state())
    }
}
