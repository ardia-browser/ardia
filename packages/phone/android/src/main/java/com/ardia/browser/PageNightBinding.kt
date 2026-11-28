package com.ardia.browser

internal class PageNightBinding<C : Any>(
    private val resolve: () -> C,
    private val nightOf: (C) -> Boolean,
    private val rebind: (C) -> Unit,
    private val redraw: (C) -> Unit,
    private val report: (Boolean) -> Unit,
) {
    private var bound: C? = null
    private var reported: Boolean? = null

    fun forNewPage(): C {
        apply()
        return checkNotNull(bound)
    }

    fun apply() {
        val context = resolve()
        val before = bound
        if (context !== before) {
            bound = context
            rebind(context)
            if (before != null && nightOf(before) != nightOf(context)) redraw(context)
        }
        val night = nightOf(context)
        if (reported != night) {
            reported = night
            report(night)
        }
    }
}
