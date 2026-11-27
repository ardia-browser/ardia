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

    fun processEnded(shown: Boolean): Step {
        if (isReloading && shown) {
            isReloading = false
            awaitsReload = false
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

    fun loadFinished(): PageProcessOutcome? {
        if (!isReloading) return null
        isReloading = false
        return PageProcessOutcome.Recovered
    }

    fun loadFailed() {
        isReloading = false
    }
}
