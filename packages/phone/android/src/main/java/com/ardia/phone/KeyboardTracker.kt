package com.ardia.phone

class KeyboardTracker(
    private val density: Float,
    private val willChange: (Will) -> Unit,
    private val didChange: (Did) -> Unit,
) {
    data class Will(val source: Double, val target: Double, val durationMs: Long, val navigationBar: Double)

    data class Did(val height: Double, val navigationBar: Double)

    private var sourcePx = 0
    private var navigationPx = 0
    private var reportedPx: Int? = null

    fun prepare(sourcePx: Int, navigationPx: Int) {
        this.sourcePx = sourcePx
        this.navigationPx = navigationPx
    }

    fun start(targetPx: Int, durationMs: Long) {
        if (targetPx == sourcePx) return
        willChange(Will(dp(sourcePx), dp(targetPx), durationMs.coerceAtLeast(0), dp(navigationPx)))
    }

    fun end(nowPx: Int) = report(nowPx)

    fun settled(nowPx: Int, navigationPx: Int) {
        this.navigationPx = navigationPx
        report(nowPx)
    }

    fun current(): Did = Did(dp(reportedPx ?: 0), dp(navigationPx))

    private fun report(nowPx: Int) {
        if (reportedPx == nowPx) return
        reportedPx = nowPx
        didChange(Did(dp(nowPx), dp(navigationPx)))
    }

    private fun dp(px: Int): Double = (px / density).toDouble()
}
