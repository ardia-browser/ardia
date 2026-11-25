package com.ardia.browser

import java.net.URI

interface RememberedSitePermissions {
    fun allows(origin: String, permission: SitePermission): Boolean

    fun remember(origin: String, host: String, permission: SitePermission)
}

object SiteOrigin {
    fun of(raw: String): String? {
        val uri = runCatching { URI(raw.trim()) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        val defaultPort = when (scheme) {
            "https" -> 443
            "http" -> 80
            else -> -1
        }
        return if (uri.port == -1 || uri.port == defaultPort) "$scheme://$host" else "$scheme://$host:${uri.port}"
    }

    fun parts(permission: SitePermission): Set<SitePermission> = when (permission) {
        SitePermission.CameraAndMicrophone -> setOf(SitePermission.Camera, SitePermission.Microphone)
        else -> setOf(permission)
    }

    fun overlaps(permission: SitePermission, revoked: Set<SitePermission>): Boolean {
        val revokedParts = revoked.flatMap(::parts).toSet()
        return parts(permission).any(revokedParts::contains)
    }
}
