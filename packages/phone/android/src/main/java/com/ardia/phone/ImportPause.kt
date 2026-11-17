package com.ardia.phone

class ImportPause(
    requested: String?,
    lab: Boolean = PhoneLab.isOn,
    private val seconds: Int = DEFAULT_SECONDS,
    private val sleep: (step: String, seconds: Int) -> Unit = ::sleepAndSay,
) {
    private val step: String? = if (lab) STEPS[requested] else null
    private var paused = false

    fun reached(step: String) {
        if (paused || step != this.step) return
        paused = true
        sleep(step, seconds)
    }

    companion object {
        const val EXTRA = "ArdiaImportPause"
        const val DEFAULT_SECONDS = 20
        private val STEPS = mapOf("afterReceipt" to "settingsStart", "afterSettings" to "settingsDone", "beforeMarker" to "beforeMarker")

        @Volatile
        private var current: ImportPause? = null

        fun forLaunch(requested: String?): ImportPause = current ?: ImportPause(requested).also { current = it }

        private fun sleepAndSay(step: String, seconds: Int) {
            android.util.Log.i("PAGELAB", "PAGELAB upgrade paused at $step for $seconds s: kill now with adb shell am force-stop")
            Thread.sleep(seconds * 1000L)
            android.util.Log.i("PAGELAB", "PAGELAB upgrade resumed after $step")
        }
    }
}
