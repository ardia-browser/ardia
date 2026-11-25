package com.ardia.phone

import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LegacyModule : Module() {
    private val context: Context
        get() = appContext.reactContext?.applicationContext ?: throw CodedException("ERR_NO_CONTEXT", "The app context is gone", null)

    private fun pausing(app: Context): PhoneLegacy {
        val requested = appContext.currentActivity?.intent?.getStringExtra(ImportPause.EXTRA)
        return PhoneLegacy(app, reached = ImportPause.forLaunch(requested)::reached)
    }

    private fun <T> reading(block: () -> T): T = try {
        block()
    } catch (unusable: LegacyUnusable) {
        throw CodedException("ERR_LEGACY_${unusable.reason.uppercase()}", unusable.message, unusable)
    }

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneLegacy")

        AsyncFunction("source") { -> PhoneLegacy(context).source() }

        AsyncFunction("readLegacy") { -> reading { PhoneLegacy(context).read() } }

        AsyncFunction("readVisits") { afterId: Double, limit: Int -> reading { PhoneLegacy(context).readVisits(afterId.toLong(), limit) } }

        AsyncFunction("applyNativeSettings") { -> reading { pausing(context).applyNativeSettings() } }

        Function("labSetUnusable") { on: Boolean -> PhoneLegacy(context).setLabUnusable(on) }

        AsyncFunction("startFresh") { ->
            val app = context
            reading { PhoneLegacy(app).startFresh { if (SyncOffer.isOffered) PhoneSync.controller(app).localDidChange() } }
        }

        AsyncFunction("markImportedWith") { receipt: Map<String, Any?> ->
            val parsed = UpgradeGate.Receipt.of(org.json.JSONObject(receipt))
                ?: throw CodedException("ERR_LEGACY_RECEIPT", "The import receipt is not valid", null)
            val app = context
            reading {
                pausing(app).markImported(parsed) { if (SyncOffer.isOffered) PhoneSync.controller(app).localDidChange() }
            }
        }
    }
}
