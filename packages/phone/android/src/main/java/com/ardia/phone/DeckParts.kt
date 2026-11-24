package com.ardia.phone

import android.app.Activity
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import com.facebook.react.views.view.ReactViewGroup

internal object DeckParts {
    enum class Part(val label: String) {
        Shadows("elevation and shadows set to 0"),
        Clips("rounded clips off (clipToOutline and overflow hidden)"),
        Snapshots("page pictures hidden (image views 100 dp and wider)"),
        Alpha("partly transparent views made opaque, so none is drawn offscreen"),
        Layers("partly transparent views held on hardware layers"),
        Bar("the deck bar's plates hidden"),
        Headers("card headers (fade views) hidden"),
        Under("everything drawn under the deck hidden"),
        Pages("web pages hidden"),
        Restore("everything put back"),
    }

    private val restores = ArrayList<() -> Unit>()
    private val applied = LinkedHashSet<Part>()

    data class Inventory(
        val shown: Int,
        val offscreenEachFrame: List<String>,
        val hardwareLayers: Int,
        val hardwareLayerPixels: Long,
        val shadows: Int,
        val outlineClips: Int,
        val overflowClips: Int,
        val images: Int,
        val largeImages: Int,
        val fadeViews: Int,
        val lookViews: Int,
        val fullScreen: List<String>,
        val webViews: Int,
    )

    fun isOffscreenEachFrame(view: View): Boolean =
        view.alpha > 0f && view.alpha < 1f && view.hasOverlappingRendering() && view.layerType == View.LAYER_TYPE_NONE && view.width > 0 && view.height > 0

    private fun shownViews(root: View): List<View> {
        val out = ArrayList<View>()
        fun walk(view: View) {
            if (view.visibility != View.VISIBLE || view.alpha == 0f) return
            out += view
            if (view is ViewGroup) for (index in 0 until view.childCount) walk(view.getChildAt(index))
        }
        walk(root)
        return out
    }

    private fun overflow(view: View): String? = (view as? ReactViewGroup)?.overflow

    private fun drawsSomething(view: View): Boolean =
        view.background != null || view is LookView || view is android.webkit.WebView || view is android.view.SurfaceView || view is android.view.TextureView || view is ImageView

    private fun deckBackdrop(): DeckBackdropView? = DeckBackdrops.all().firstOrNull { it.isShown }

    private fun underDeck(): List<View> {
        val out = ArrayList<View>()
        var child: View = deckBackdrop() ?: return out
        var parent = child.parent as? ViewGroup
        while (parent != null) {
            val at = parent.indexOfChild(child)
            for (index in 0 until at) parent.getChildAt(index).takeIf { it.visibility == View.VISIBLE }?.let(out::add)
            child = parent
            parent = parent.parent as? ViewGroup
        }
        return out
    }

    fun inventory(root: View): Inventory {
        val views = shownViews(root)
        val density = root.resources.displayMetrics.density
        val offscreen = views.filter(::isOffscreenEachFrame)
            .sortedByDescending { it.width.toLong() * it.height }
            .map { "${FrameTrace.label(it)} ${it.width}x${it.height} alpha ${"%.2f".format(it.alpha)}" }
        val layers = views.filter { it.layerType == View.LAYER_TYPE_HARDWARE }
        return Inventory(
            shown = views.size,
            offscreenEachFrame = offscreen,
            hardwareLayers = layers.size,
            hardwareLayerPixels = layers.sumOf { it.width.toLong() * it.height },
            shadows = views.count { it.elevation > 0f || it.translationZ > 0f },
            outlineClips = views.count { it.clipToOutline },
            overflowClips = views.count { overflow(it) == "hidden" },
            images = views.count { it is ImageView },
            largeImages = views.count { it is ImageView && it.width >= 100 * density },
            fadeViews = views.count { it is FadeView },
            lookViews = views.count { it is LookView || it is FrostSourceView },
            fullScreen = views.filter { it.width.toLong() * it.height >= root.width.toLong() * root.height * 8 / 10 && drawsSomething(it) }
                .map { "${FrameTrace.label(it)}${if (it.background != null) " with a background" else ""}" },
            webViews = views.count { it is android.webkit.WebView },
        )
    }

    fun line(inventory: Inventory): String =
        "PAGELAB deck parts: ${inventory.shown} view(s) shown; ${inventory.offscreenEachFrame.size} drawn offscreen every frame (partly transparent, overlapping, no layer)" +
            (if (inventory.offscreenEachFrame.isEmpty()) "" else " [${inventory.offscreenEachFrame.take(12).joinToString("; ")}${if (inventory.offscreenEachFrame.size > 12) "; and ${inventory.offscreenEachFrame.size - 12} more" else ""}]") +
            "; ${inventory.hardwareLayers} hardware layer(s), ${"%.1f".format(inventory.hardwareLayerPixels / 1_000_000.0)} Mpx; ${inventory.shadows} with elevation; " +
            "${inventory.outlineClips} outline clip(s), ${inventory.overflowClips} overflow-hidden clip(s); ${inventory.images} image view(s), ${inventory.largeImages} of them pictures; " +
            "${inventory.fadeViews} fade view(s); ${inventory.lookViews} look view(s); ${inventory.webViews} web view(s) shown; " +
            "${inventory.fullScreen.size} full-screen view(s) that draw, in drawing order [${inventory.fullScreen.joinToString("; ")}]; " +
            "${underDeck().size} view(s) drawn under the deck; applied: ${applied.joinToString { it.name.lowercase() }.ifEmpty { "nothing" }}"

    fun apply(activity: Activity, part: Part): String {
        val root = activity.window?.decorView ?: return "PAGELAB deck parts: no window"
        if (part == Part.Restore) {
            restores.asReversed().forEach { runCatching(it) }
            restores.clear()
            applied.clear()
            root.invalidate()
            return "PAGELAB deck parts: restored; " + line(inventory(root))
        }
        val density = root.resources.displayMetrics.density
        var changed = 0
        if (part == Part.Under) {
            for (view in underDeck()) {
                view.visibility = View.INVISIBLE
                restores += { view.visibility = View.VISIBLE }
                changed += 1
            }
        }
        for (view in shownViews(root)) {
            when (part) {
                Part.Shadows -> if (view.elevation > 0f || view.translationZ > 0f) {
                    val elevation = view.elevation
                    val z = view.translationZ
                    view.elevation = 0f
                    view.translationZ = 0f
                    restores += { view.elevation = elevation; view.translationZ = z }
                    changed += 1
                }
                Part.Clips -> {
                    if (view.clipToOutline) {
                        view.clipToOutline = false
                        restores += { view.clipToOutline = true }
                        changed += 1
                    }
                    if (view is ReactViewGroup && view.overflow == "hidden") {
                        view.overflow = "visible"
                        restores += { view.overflow = "hidden" }
                        changed += 1
                    }
                }
                Part.Snapshots -> if (view is ImageView && view.width >= 100 * density) {
                    view.visibility = View.INVISIBLE
                    restores += { view.visibility = View.VISIBLE }
                    changed += 1
                }
                Part.Alpha -> if (isOffscreenEachFrame(view)) {
                    val alpha = view.alpha
                    view.alpha = 1f
                    restores += { view.alpha = alpha }
                    changed += 1
                }
                Part.Layers -> if (isOffscreenEachFrame(view)) {
                    view.setLayerType(View.LAYER_TYPE_HARDWARE, null)
                    restores += { view.setLayerType(View.LAYER_TYPE_NONE, null) }
                    changed += 1
                }
                Part.Bar -> if (view is FrostView) {
                    val plate = view.parent as? View ?: continue
                    if (plate.visibility == View.VISIBLE) {
                        plate.visibility = View.INVISIBLE
                        restores += { plate.visibility = View.VISIBLE }
                        changed += 1
                    }
                }
                Part.Headers -> if (view is FadeView) {
                    view.visibility = View.INVISIBLE
                    restores += { view.visibility = View.VISIBLE }
                    changed += 1
                }
                Part.Pages -> if (view is android.webkit.WebView) {
                    view.visibility = View.INVISIBLE
                    restores += { view.visibility = View.VISIBLE }
                    changed += 1
                }
                Part.Under, Part.Restore -> Unit
            }
        }
        applied += part
        root.invalidate()
        return "PAGELAB deck parts: ${part.label}, $changed view(s) changed; " + line(inventory(root))
    }

    fun parse(name: String?): Part? = Part.entries.firstOrNull { it.name.equals(name, ignoreCase = true) }
}
