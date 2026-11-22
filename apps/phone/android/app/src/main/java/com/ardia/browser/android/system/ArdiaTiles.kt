package com.ardia.browser.android.system

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.ardia.appmodel.SystemLink
import com.ardia.browser.android.SystemIntents
import com.ardia.phone.PendingCounts
import com.ardia.phone.UsageConsent

abstract class ArdiaTileService(private val link: SystemLink, private val countedAs: String, private val requestCode: Int) : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        qsTile?.apply {
            state = Tile.STATE_INACTIVE
            updateTile()
        }
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    override fun onClick() {
        super.onClick()
        val intent = tileIntent()
        val open = {
            PendingCounts.add(this, countedAs, UsageConsent.window(this))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startActivityAndCollapse(PendingIntent.getActivity(this, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            } else {
                @Suppress("DEPRECATION")
                startActivityAndCollapse(intent)
            }
        }
        if (isLocked) unlockAndRun(open) else open()
    }

    fun tileIntent(): Intent = SystemIntents.main(this, link)
}

class SearchTileService : ArdiaTileService(SystemLink.Search(null), "search_tile_taps", 41)

class VoiceSearchTileService : ArdiaTileService(SystemLink.VoiceSearch, "voice_tile_taps", 42)

class IncognitoTileService : ArdiaTileService(SystemLink.Incognito, "incognito_tile_taps", 43)
