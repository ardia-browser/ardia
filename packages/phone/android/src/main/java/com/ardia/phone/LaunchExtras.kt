package com.ardia.phone

import android.content.Intent
import com.ardia.appmodel.LaunchArguments
import com.ardia.browser.BuildConfig

object LaunchExtras {
    private val prefixes = listOf("Ardia", "Browse")

    val allowedInThisBuild: Boolean get() = PhoneLab.isOn || BuildConfig.DEBUG

    fun of(intent: Intent?): Map<String, Any?> {
        val extras = intent?.extras ?: return emptyMap()
        @Suppress("DEPRECATION")
        return runCatching { extras.keySet().associateWith { extras.get(it) } }.getOrDefault(emptyMap())
    }

    fun arguments(extras: Map<String, Any?>, allowed: Boolean = allowedInThisBuild): Map<String, Any> {
        if (!allowed) return emptyMap()
        return extras.entries.mapNotNull { (key, value) ->
            if (prefixes.none(key::startsWith)) return@mapNotNull null
            val passed: Any = when (value) {
                null -> return@mapNotNull null
                is Boolean -> value
                is Number -> value.toDouble()
                else -> value.toString()
            }
            key to passed
        }.toMap()
    }

    fun isDemo(extras: Map<String, Any?>, allowed: Boolean = allowedInThisBuild): Boolean {
        if (!allowed) return false
        if (extras[PhoneSync.DEMO_EXTRA] == true) return true
        return LaunchArguments.parse(extras).isDemo
    }
}
