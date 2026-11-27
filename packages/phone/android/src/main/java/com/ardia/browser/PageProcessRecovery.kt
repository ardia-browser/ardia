package com.ardia.browser

enum class PageProcessOutcome(val wire: String) {
    Gone("gone"),
    Recovered("recovered"),
    Failed("failed"),
}

internal class PageProcessRecovery {
    enum class Step { Wait, Reload, ShowFailure }

    var awaitsReload = false
        private set
    var isReloading = false
        private set
    private var recoveredAt: Long? = null

    fun processEnded(shown: Boolean, now: Long): Step {
        val diedRightAfterRecovery = recoveredAt?.let { now - it < RETRY_WINDOW_MS } ?: false
        if (shown && (isReloading || diedRightAfterRecovery)) {
            isReloading = false
            awaitsReload = false
            recoveredAt = null
            return Step.ShowFailure
        }
        isReloading = false
        awaitsReload = true
        return if (shown) Step.Reload else Step.Wait
    }

    fun reloadStarted() {
        if (!awaitsReload) return
        awaitsReload = false
        isReloading = true
    }

    fun personReloaded() {
        recoveredAt = null
    }

    fun loadFinished(now: Long): PageProcessOutcome? {
        if (!isReloading) return null
        isReloading = false
        recoveredAt = now
        return PageProcessOutcome.Recovered
    }

    fun loadFailed() {
        isReloading = false
    }

    companion object {
        const val RETRY_WINDOW_MS = 60_000L
    }
}
