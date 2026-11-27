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
        if (isReloading) {
            isReloading = false
            awaitsReload = false
            return Step.ShowFailure
        }
        awaitsReload = true
        return if (shown) beginReload() else Step.Wait
    }

    fun navigationAsked() {
        if (awaitsReload) beginReload()
    }

    fun loadFinished(): PageProcessOutcome? {
        if (!isReloading) return null
        isReloading = false
        return PageProcessOutcome.Recovered
    }

    fun loadFailed() {
        isReloading = false
    }

    private fun beginReload(): Step {
        awaitsReload = false
        isReloading = true
        return Step.Reload
    }
}
