package com.ardia.browser

internal class ShownPage {
    private var id: String? = null
    private var inFront = false

    fun isShown(pageId: String): Boolean = inFront && id == pageId

    fun show(next: String?): String? {
        if (id == next) return null
        id = next
        return if (inFront) next else null
    }

    fun enterFront(): String? {
        if (inFront) return null
        inFront = true
        return id
    }

    fun leaveFront() {
        inFront = false
    }
}
