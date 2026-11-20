package com.ardia.phone

import android.content.Context
import android.os.Build

internal object AppReleaseInfo {
    fun of(context: Context): Map<String, Any?> {
        val id = context.resources.getIdentifier("ardia_release_version", "string", context.packageName)
        val releaseVersion = if (id == 0) "" else context.getString(id)
        return mapOf("releaseVersion" to releaseVersion, "build" to versionCode(context).toString(), "receiptName" to null)
    }

    @Suppress("DEPRECATION")
    private fun versionCode(context: Context): Long {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
    }
}
