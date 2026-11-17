package com.ardia.phone

import android.content.SharedPreferences
import com.ardia.browser.BrowserUrl
import com.ardia.browser.RememberedSitePermissions
import com.ardia.browser.SiteOrigin
import com.ardia.browser.SitePermission
import org.json.JSONArray
import org.json.JSONObject

enum class SiteCapability(val raw: String, val permission: SitePermission) {
    Camera("camera", SitePermission.Camera),
    Microphone("microphone", SitePermission.Microphone),
    Location("location", SitePermission.Location),
    ;

    companion object {
        fun of(raw: String): SiteCapability? = entries.firstOrNull { it.raw == raw }

        fun of(permission: SitePermission): Set<SiteCapability> = when (permission) {
            SitePermission.Camera -> setOf(Camera)
            SitePermission.Microphone -> setOf(Microphone)
            SitePermission.CameraAndMicrophone -> setOf(Camera, Microphone)
            SitePermission.Location -> setOf(Location)
        }
    }
}

data class SiteGrant(val origin: String, val host: String, val permissions: Set<SiteCapability>, val grantedAt: Long)

class SitePermissionStore(
    private val preferences: SharedPreferences,
    private val held: (SitePermission) -> Boolean = { true },
    private val now: () -> Long = System::currentTimeMillis,
) : RememberedSitePermissions {
    @Volatile
    var grants: List<SiteGrant> = sorted(load())
        private set

    @Synchronized
    override fun allows(origin: String, permission: SitePermission): Boolean {
        val site = SiteOrigin.of(origin) ?: return false
        val grant = grants.firstOrNull { it.origin == site } ?: return false
        return grant.permissions.containsAll(SiteCapability.of(permission)) && held(permission)
    }

    @Synchronized
    override fun remember(origin: String, host: String, permission: SitePermission) {
        val site = SiteOrigin.of(origin) ?: return
        val granted = SiteCapability.of(permission)
        val next = grants.toMutableList()
        val index = next.indexOfFirst { it.origin == site }
        if (index >= 0) {
            next[index] = next[index].copy(permissions = next[index].permissions + granted, grantedAt = now())
        } else {
            next += SiteGrant(site, host.ifBlank { BrowserUrl.rawHost(site) ?: site }, granted, now())
        }
        if (next.size > LIMIT) {
            next.filter { it.origin != site }.minByOrNull { it.grantedAt }?.let { oldest -> next.removeAll { it.origin == oldest.origin } }
        }
        save(next)
    }

    @Synchronized
    fun revoke(origin: String, permission: SiteCapability?): Set<SiteCapability> {
        val site = SiteOrigin.of(origin) ?: origin
        val grant = grants.firstOrNull { it.origin == site } ?: return emptySet()
        val revoked = if (permission == null) grant.permissions else setOf(permission).intersect(grant.permissions)
        if (revoked.isEmpty()) return emptySet()
        val left = grant.permissions - revoked
        save(if (left.isEmpty()) grants.filter { it.origin != site } else grants.map { if (it.origin == site) it.copy(permissions = left) else it })
        return revoked
    }

    private fun save(next: List<SiteGrant>) {
        grants = sorted(next)
        val array = JSONArray()
        for (grant in grants) {
            array.put(
                JSONObject()
                    .put("origin", grant.origin)
                    .put("host", grant.host)
                    .put("permissions", JSONArray(grant.permissions.sortedBy { it.ordinal }.map { it.raw }))
                    .put("grantedAt", grant.grantedAt),
            )
        }
        preferences.edit().putString(KEY, array.toString()).apply()
    }

    private fun load(): List<SiteGrant> {
        val stored = preferences.getString(KEY, null) ?: return emptyList()
        val array = runCatching { JSONArray(stored) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            val origin = item.optString("origin").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val names = item.optJSONArray("permissions") ?: return@mapNotNull null
            val permissions = (0 until names.length()).mapNotNull { SiteCapability.of(names.optString(it)) }.toSet()
            if (permissions.isEmpty()) return@mapNotNull null
            SiteGrant(origin, item.optString("host").ifEmpty { origin }, permissions, item.optLong("grantedAt"))
        }
    }

    companion object {
        const val KEY = "browsing.sitePermissions"
        const val LIMIT = 200

        private fun sorted(list: List<SiteGrant>): List<SiteGrant> = list.sortedWith(compareBy<SiteGrant> { it.host }.thenBy { it.origin })
    }
}
