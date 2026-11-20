package com.ardia.browser.android

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.service.quicksettings.TileService
import androidx.test.core.app.ApplicationProvider
import com.ardia.browser.android.system.ArdiaTileService
import com.ardia.browser.android.system.IncognitoTileService
import com.ardia.browser.android.system.SearchTileService
import com.ardia.browser.android.system.VoiceSearchTileService
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TileServicesTest {
    private fun intentOf(service: Class<out ArdiaTileService>): Intent = Robolectric.buildService(service).create().get().tileIntent()

    @Test
    fun eachTileOpensWhatTheMatchingLauncherShortcutOpens() {
        val opened = listOf(SearchTileService::class.java, VoiceSearchTileService::class.java, IncognitoTileService::class.java).map { intentOf(it) }
        assertEquals(listOf("ardia://search", "ardia://voice", "ardia://incognito"), opened.map { it.dataString })
        for (intent in opened) {
            assertEquals(Intent.ACTION_VIEW, intent.action)
            assertEquals(MainActivity::class.java.name, intent.component?.className)
        }
    }

    @Test
    fun theSystemOffersAllThreeTilesWithTheirIphoneNames() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val services = context.packageManager.queryIntentServices(Intent(TileService.ACTION_QS_TILE).setPackage(context.packageName), PackageManager.GET_META_DATA)
        val labels = services.associate { it.serviceInfo.name to it.serviceInfo.loadLabel(context.packageManager).toString() }
        assertEquals(
            mapOf(
                SearchTileService::class.java.name to "Search",
                VoiceSearchTileService::class.java.name to "Voice Search",
                IncognitoTileService::class.java.name to "Incognito Tab",
            ),
            labels,
        )
        for (service in services) assertEquals(android.Manifest.permission.BIND_QUICK_SETTINGS_TILE, context.packageManager.getServiceInfo(ComponentName(context, service.serviceInfo.name), 0).permission)
    }
}
