package com.ardia.phone

import android.content.Context
import com.ardia.browser.PageEngine
import com.ardia.browser.PageZoom

object PageCapabilities {
    fun payload(context: Context): Map<String, Any?> {
        val engine = if (UpgradeGate.pending(context)) null else PhonePages.engine(context)
        return of(engine)
    }

    fun of(engine: PageEngine?): Map<String, Any?> = mapOf(
        "ready" to (engine != null),
        "engineName" to (engine?.name ?: NOT_READY_NAME),
        "isDevelopmentOnly" to (engine?.isDevelopmentOnly ?: true),
        "supportsPrivatePages" to (engine?.separatesPrivatePages ?: false),
        "pageZoomLevels" to PageZoom.levels,
        "pageZoomScalesTextOnly" to true,
        "snapshotsIncludeVideo" to false,
    )

    private const val NOT_READY_NAME = "not ready: the import from the previous app has not finished"
}
