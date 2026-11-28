package com.ardia.browser

import java.net.IDN

object PageHost {
    fun key(url: String): String? {
        val host = BrowserUrl.rawHost(url) ?: return null
        val ascii = runCatching { IDN.toASCII(host, IDN.ALLOW_UNASSIGNED) }.getOrDefault(host)
        return ascii.lowercase().trimEnd('.').ifEmpty { null }
    }
}
