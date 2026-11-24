package com.ardia.browser

object DesktopSites {
    fun key(host: String): String {
        val lower = host.lowercase().trim('.', ' ')
        return if (lower.startsWith("www.")) lower.substring(4) else lower
    }

    fun onEnter(host: String?, lastHost: String?, current: Boolean, preference: Boolean?): Boolean? {
        host ?: return null
        if (lastHost != null && key(host) == key(lastHost)) return null
        return preference?.takeIf { it != current }
    }
}
