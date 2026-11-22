package com.ardia.browser

object ErrorPages {
    fun titleOnFailure(current: String, titledUrl: String?, failedUrl: String): String {
        val sameAddress = titledUrl != null && BrowserUrl.withoutFragment(titledUrl) == BrowserUrl.withoutFragment(failedUrl)
        if (sameAddress && current.isNotBlank()) return current
        return BrowserUrl.host(failedUrl) ?: current
    }

    fun takesFromPage(failedUrl: String?): Boolean = failedUrl == null

    fun capturable(failure: PageLoadFailure?): Boolean = failure == null

    fun tone(failure: PageLoadFailure?, resolved: PageTone): PageTone = if (failure == null) resolved else PageTone()
}
