package com.ardia.phone

import android.content.SharedPreferences
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Locale

object PageTranslation {
    private const val PROXY_HOST_SUFFIX = ".translate.goog"
    private const val START_HOST = "translate.google.com"

    fun url(page: String, language: String): String = "https://$START_HOST/translate?sl=auto&tl=${encoded(language)}&u=${encoded(page)}"

    fun chosenLanguage(url: String): String? {
        val parsed = runCatching { URI(url) }.getOrNull() ?: return null
        val host = parsed.host?.lowercase(Locale.ROOT) ?: return null
        val name = when {
            host.endsWith(PROXY_HOST_SUFFIX) -> "_x_tr_tl"
            host == START_HOST && parsed.path == "/translate" -> "tl"
            else -> return null
        }
        val value = parsed.rawQuery.orEmpty().split('&').mapNotNull { pair ->
            val parts = pair.split('=', limit = 2)
            if (decoded(parts[0]) == name) decoded(parts.getOrElse(1) { "" }) else null
        }.lastOrNull() ?: return null
        return value.takeIf(::isLanguageCode)
    }

    fun systemLanguage(preferred: List<Locale> = listOf(Locale.getDefault())): String {
        val first = preferred.firstOrNull() ?: return "en"
        val code = first.language.ifEmpty { return "en" }
        if (code != "zh") return code
        return if (first.script == "Hant" || first.country == "TW" || first.country == "HK") "zh-TW" else "zh-CN"
    }

    fun displayName(language: String, locale: Locale = Locale.getDefault()): String? =
        Locale.forLanguageTag(language).getDisplayName(locale).takeIf { it.isNotBlank() && !it.equals(language, ignoreCase = true) }

    fun isLanguageCode(value: String): Boolean = value.length in 2..12 && value != "auto" && value.all { it == '-' || it in 'a'..'z' || it in 'A'..'Z' }

    private fun encoded(value: String) = URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private fun decoded(value: String) = runCatching { URLDecoder.decode(value, Charsets.UTF_8.name()) }.getOrDefault(value)
}

class PhoneTranslation(private val preferences: SharedPreferences, private val systemLanguage: () -> String = { PageTranslation.systemLanguage() }) {
    val language: String? get() = preferences.getString(LANGUAGE, null)?.takeIf(PageTranslation::isLanguageCode)

    var confirmed: Boolean
        get() = preferences.getBoolean(CONFIRMED, false)
        set(value) {
            preferences.edit().putBoolean(CONFIRMED, value).apply()
        }

    val target: String get() = language ?: systemLanguage()

    fun remember(url: String?, isPrivate: Boolean) {
        if (isPrivate || url == null) return
        val chosen = PageTranslation.chosenLanguage(url) ?: return
        if (chosen != language) preferences.edit().putString(LANGUAGE, chosen).apply()
    }

    fun url(page: String): String = PageTranslation.url(page, target)

    fun state(): Map<String, Any?> = language.let { mapOf("language" to it, "languageName" to it?.let(PageTranslation::displayName), "confirmed" to confirmed) }

    companion object {
        const val LANGUAGE = "browsing.translateLanguage"
        const val CONFIRMED = "browsing.translateConfirmed"
    }
}
