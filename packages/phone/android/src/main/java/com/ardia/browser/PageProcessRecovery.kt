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
    var showsFailure = false
        private set
    private var recoveredAt: Long? = null
    private var committedHost: String? = null

    fun processEnded(shown: Boolean, now: Long): Step {
        val diedRightAfterRecovery = recoveredAt?.let { now - it < RETRY_WINDOW_MS } ?: false
        if (shown && (isReloading || diedRightAfterRecovery)) {
            isReloading = false
            awaitsReload = false
            recoveredAt = null
            showsFailure = true
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

    fun revivesWhenShown(queuedLoad: Boolean): Boolean = awaitsReload || queuedLoad

    fun loadsWhenMadeLive(shown: Boolean): Boolean = !showsFailure && (!awaitsReload || shown)

    fun personReloaded() {
        recoveredAt = null
        if (!showsFailure) return
        showsFailure = false
        awaitsReload = true
    }

    fun personOpened() {
        recoveredAt = null
        showsFailure = false
    }

    fun pageCommitted(host: String?) {
        if (host != committedHost) recoveredAt = null
        committedHost = host
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
