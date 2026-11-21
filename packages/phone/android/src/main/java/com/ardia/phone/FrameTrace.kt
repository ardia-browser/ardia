package com.ardia.phone

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver

internal object FrameTrace {
    data class Result(val frames: Int, val seconds: Double, val passes: Int, val layouts: Int, val nothingRedrawn: Int, val redrawn: List<Pair<String, Int>>, val look: List<Pair<String, Int>> = emptyList())

    const val MOST_LISTED = 16

    fun isLook(view: View): Boolean = view is LookView || view is FrostSourceView

    fun dirtyLook(view: View, out: MutableList<View>) {
        if (!view.isDirty) return
        if (isLook(view)) out += view
        if (view is ViewGroup) for (index in 0 until view.childCount) dirtyLook(view.getChildAt(index), out)
    }

    fun dirtyLeaves(view: View, out: MutableList<View>): Boolean {
        var childDirty = false
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) if (dirtyLeaves(view.getChildAt(index), out)) childDirty = true
        }
        if (view.isDirty && !childDirty) out += view
        return view.isDirty || childDirty
    }

    fun label(view: View): String {
        val name = view.javaClass.simpleName.ifEmpty { view.javaClass.name.substringAfterLast('.') }
        val described = view.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { " \"${it.take(32)}\"" } ?: ""
        val tag = if (view.id > 0) " @${view.id}" else ""
        return "$name$described$tag"
    }

    fun line(result: Result): String {
        val others = result.redrawn.filter { (label, _) -> result.look.none { it.first == label } }
        val listed = others.take(MOST_LISTED).joinToString(", ") { (label, count) -> "$label x$count" }.ifEmpty { "nothing" }
        val more = if (others.size > MOST_LISTED) " and ${others.size - MOST_LISTED} more" else ""
        val look = result.look.joinToString(", ") { (label, count) -> "$label x$count" }.ifEmpty { "none" }
        return "PAGELAB idle frames: ${result.frames} frame(s) drawn in ${"%.1f".format(result.seconds)} s, ${result.passes} draw pass(es), " +
            "${result.layouts} layout pass(es), ${result.nothingRedrawn} pass(es) with no view redrawn; look views redrawn: $look; redrawn: $listed$more"
    }

    fun trace(activity: Activity, millis: Long, done: (Result) -> Unit) {
        val decor = activity.window?.decorView ?: return
        val observer = decor.viewTreeObserver
        val counts = HashMap<String, Int>()
        val lookCounts = HashMap<String, Int>()
        val lookViews = ArrayList<View>()
        var passes = 0
        var layouts = 0
        var nothing = 0
        val leaves = ArrayList<View>()
        val predraw = ViewTreeObserver.OnPreDrawListener {
            passes += 1
            leaves.clear()
            dirtyLeaves(decor, leaves)
            if (leaves.isEmpty()) nothing += 1
            for (view in leaves) counts.merge(label(view), 1, Int::plus)
            lookViews.clear()
            dirtyLook(decor, lookViews)
            for (view in lookViews) lookCounts.merge(label(view), 1, Int::plus)
            true
        }
        val laidOut = ViewTreeObserver.OnGlobalLayoutListener { layouts += 1 }
        observer.addOnPreDrawListener(predraw)
        observer.addOnGlobalLayoutListener(laidOut)
        FrameSampler.sample(activity, millis) { sample ->
            Handler(Looper.getMainLooper()).post {
                decor.viewTreeObserver.removeOnPreDrawListener(predraw)
                decor.viewTreeObserver.removeOnGlobalLayoutListener(laidOut)
                done(Result(sample?.totals?.size ?: 0, millis / 1000.0, passes, layouts, nothing, counts.entries.sortedByDescending { it.value }.map { it.key to it.value }, lookCounts.entries.sortedByDescending { it.value }.map { it.key to it.value }))
            }
        }
    }
}
