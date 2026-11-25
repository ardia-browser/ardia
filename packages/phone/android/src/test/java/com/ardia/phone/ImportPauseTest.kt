package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class ImportPauseTest {
    private val slept = ArrayList<String>()

    private fun pause(requested: String?, lab: Boolean = true) = ImportPause(requested, lab, seconds = 20) { step, seconds -> slept += "$step $seconds" }

    @Test
    fun eachRequestedPointPausesOnceAtItsDurableStep() {
        val afterReceipt = pause("afterReceipt")
        listOf("settingsStart", "blocking", "settingsDone", "settingsStart", "settingsDone", "beforeMarker").forEach(afterReceipt::reached)
        assertEquals(listOf("settingsStart 20"), slept)
        slept.clear()
        val afterSettings = pause("afterSettings")
        listOf("settingsStart", "settingsDone", "settingsStart", "settingsDone", "beforeMarker").forEach(afterSettings::reached)
        assertEquals(listOf("settingsDone 20"), slept)
        slept.clear()
        val beforeMarker = pause("beforeMarker")
        listOf("settingsStart", "settingsDone", "beforeMarker", "beforeMarker").forEach(beforeMarker::reached)
        assertEquals(listOf("beforeMarker 20"), slept)
    }

    @Test
    fun noRequestAnUnknownOneOrAStoreBuildNeverPauses() {
        listOf(pause(null), pause("sometime"), pause("beforeMarker", lab = false)).forEach { paused ->
            listOf("settingsStart", "settingsDone", "beforeMarker").forEach(paused::reached)
        }
        assertEquals(emptyList<String>(), slept)
    }
}
