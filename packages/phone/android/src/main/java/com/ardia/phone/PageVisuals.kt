package com.ardia.phone

import android.view.View

internal class PageVisuals(private val clock: () -> Long = android.os.SystemClock::uptimeMillis) {
    enum class Change(val word: String) { Drew("drew"), State("changed state") }

    private class Record {
        var generation = 0L
        var captured: Long? = null
        var capturedAt = 0L
        var reported = false
    }

    private val pages = HashMap<String, Record>()

    var onNoLongerCurrent: ((pageId: String, change: Change, millisAfterCapture: Long) -> Unit)? = null

    @Synchronized
    fun changed(pageId: String, change: Change) {
        val record = pages.getOrPut(pageId, ::Record)
        record.generation++
        if (record.captured != null && !record.reported) {
            record.reported = true
            onNoLongerCurrent?.invoke(pageId, change, clock() - record.capturedAt)
        }
    }

    fun noteDirty(pageId: String, view: View?) {
        if (view != null && view.isAttachedToWindow && view.isDirty) changed(pageId, Change.Drew)
    }

    @Synchronized
    fun generation(pageId: String): Long = pages[pageId]?.generation ?: 0L

    @Synchronized
    fun captured(pageId: String, generation: Long) {
        val record = pages.getOrPut(pageId, ::Record)
        record.captured = generation
        record.capturedAt = clock()
        record.reported = record.generation != generation
    }

    @Synchronized
    fun isCurrent(pageId: String): Boolean? {
        val record = pages[pageId] ?: return null
        val captured = record.captured ?: return null
        return captured == record.generation
    }

    @Synchronized
    fun forget(pageId: String) {
        pages.remove(pageId)
    }
}
