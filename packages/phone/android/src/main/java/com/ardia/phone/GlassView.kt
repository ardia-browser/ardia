package com.ardia.phone

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.BlendMode
import android.graphics.Matrix
import android.graphics.Canvas
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.RuntimeShader
import android.os.Build
import android.view.View
import android.view.ViewTreeObserver
import android.view.ViewOutlineProvider
import android.view.animation.DecelerateInterpolator
import androidx.compose.ui.graphics.toArgb
import expo.modules.kotlin.AppContext
import com.facebook.react.uimanager.PointerEvents
import com.facebook.react.uimanager.ReactPointerEventsView
import expo.modules.kotlin.views.ExpoView
import kotlin.math.min
import kotlin.math.roundToInt

internal object GlassRules {
    const val CLASSIC_EDGE_DP = 0.5f
    const val CLASSIC_SHADOW_ELEVATION_DP = 3f
    const val DEFAULT_SHOWN_MS = 200f

    fun solid(surface: String?, reduceTransparency: Boolean): Boolean = reduceTransparency || surface == "classic"

    fun radiusDp(shape: String?, cornerRadiusDp: Float, widthDp: Float, heightDp: Float): Float =
        if (shape == "rounded") cornerRadiusDp.coerceAtLeast(0f) else min(widthDp, heightDp).coerceAtLeast(0f) / 2f

    fun classicFill(tinted: Boolean, dark: Boolean, lookSurface: Int, chromeFill: Pair<Int, Int>? = null): Int = when {
        tinted -> lookSurface
        chromeFill != null -> if (dark) chromeFill.second else chromeFill.first
        dark -> 0xFF000000.toInt()
        else -> 0xFFFFFFFF.toInt()
    }

    fun hex(raw: String?): Int? {
        val digits = raw?.trim()?.removePrefix("#") ?: return null
        if (digits.any { !it.isLetterOrDigit() }) return null
        val value = digits.toLongOrNull(16) ?: return null
        return when (digits.length) {
            6 -> (0xFF000000L or value).toInt()
            8 -> (((value and 0xFFL) shl 24) or (value ushr 8)).toInt()
            else -> null
        }
    }

    fun chromeFill(classicChrome: Map<String, Any?>?): Pair<Int, Int>? = when (val fill = classicChrome?.get("fill")) {
        is String -> hex(fill)?.let { it to it }
        is Map<*, *> -> (fill["dynamic"] as? Map<*, *>)?.let { both ->
            val light = hex(both["light"] as? String)
            val dark = hex(both["dark"] as? String)
            if (light != null && dark != null) light to dark else null
        }
        else -> null
    }

    fun classicEdge(dark: Boolean): Int = if (dark) 0x1FFFFFFF else 0x1F000000

    fun classicShadow(dark: Boolean): Int = if (dark) 0x66000000 else 0x1F000000

    fun fadesIn(wasShown: Boolean, shown: Boolean, attached: Boolean, durationMs: Float, animatorsOn: Boolean): Boolean =
        !wasShown && shown && attached && durationMs > 0f && animatorsOn
}

internal object GlassCounts {
    const val UNSOURCED_SETTLE_MS = 1000L

    var onUnsourced: (() -> Unit)? = null
}

internal class UnsourcedWatch(private val schedule: (Runnable, Long) -> Unit, private val cancel: (Runnable) -> Unit, private val stillUnsourced: () -> Boolean) {
    var counted = false
        private set
    private var waiting = false
    private val check = Runnable {
        waiting = false
        if (!counted && stillUnsourced()) {
            counted = true
            GlassCounts.onUnsourced?.invoke()
        }
    }

    fun settled(choice: FrostPage.Choice) {
        if (counted) return
        if (FrostPage.unsourced(choice)) {
            if (!waiting) {
                waiting = true
                schedule(check, GlassCounts.UNSOURCED_SETTLE_MS)
            }
        } else if (waiting) {
            waiting = false
            cancel(check)
        }
    }

    fun stop() {
        if (!waiting) return
        waiting = false
        cancel(check)
    }
}

internal object GlassLaunch {
    @Volatile
    var flat: Boolean = false
}

class GlassView(context: Context, appContext: AppContext) : FrostView(context, appContext) {
    var shape: String? = null
    var glassCornerRadius: Float = 0f
    var tint: Int? = null
    var interactive: Boolean = true
    var tinted: Boolean = false
    var barShadow: Boolean = false
    var shownMs: Float = GlassRules.DEFAULT_SHOWN_MS
    var classicFill: Pair<Int, Int>? = null
    var surface: String? = null
        set(value) {
            if (field == value) return
            field = value
            forgetLayer()
            FrostSources.sourceChanged(source)
        }
    var shown: Boolean = true
        set(value) {
            if (field == value) return
            val was = field
            field = value
            if (!value) forgetLayer() else lastChoice?.let(unsourced::settled)
            showSurface(was)
        }

    private var surfaceAlpha = 1f
    private var fader: ValueAnimator? = null
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rimPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val box = RectF()
    private val outlinePath = Path()
    private var radiusPx = 0f
    private var rimShader: RuntimeShader? = null
    private var rimDrawn: LiquidGlassRules.Rim? = null
    private val bound = LensBound()
    private val unsourced = UnsourcedWatch({ job, delay -> postDelayed(job, delay) }, { job -> removeCallbacks(job) }) { samplesNow && canBlur() && FrostPage.unsourced(lastChoice) }

    init {
        variant = "glass"
        clipChildren = false
        clipToPadding = false
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                outline.setRoundRect(0, 0, view.width, view.height, radiusPx)
            }
        }
    }

    val isClassic: Boolean get() = GlassRules.solid(surface, reduceTransparency)

    override val samplesNow: Boolean get() = super.samplesNow && shown

    override fun canBlur(): Boolean = !isClassic && super.canBlur()

    private val lensOn: Boolean get() = !GlassShaders.lens.failed && LiquidGlassRules.lensWanted(Build.VERSION.SDK_INT, isClassic, GlassLaunch.flat, livePath = true)

    internal val lensBound: LensBound get() = bound.measure(width, height, density)

    override fun pageLive(): Boolean = LiquidGlassRules.pageLive(Build.VERSION.SDK_INT, isClassic)

    override fun blursBackdrop(): Boolean = LiquidGlassRules.samplesBackdrop(Build.VERSION.SDK_INT, isClassic, GlassLaunch.flat, GlassShaders.lens.failed) || super.blursBackdrop()

    override fun solidFill(dark: Boolean): Int? = classicFill?.let { if (dark) it.second else it.first }

    override fun lensReach(): Float {
        if (!lensOn) return 0f
        return lensBound.shiftDp * density
    }

    override fun lensAt(xPx: Int, yPx: Int, scale: Float): LiquidGlassRules.StripLens? {
        if (!lensOn || Build.VERSION.SDK_INT < LiquidGlassRules.LENS_MIN_SDK || width <= 0 || height <= 0) return null
        val measured = lensBound
        val radius = GlassRules.radiusDp(shape, glassCornerRadius, width / density, height / density) * density
        return LiquidGlassRules.stripLens(xPx, yPx, width, height, scale, radius, density, measured.bezelDp, measured.shiftDp)
    }

    override fun settled(choice: FrostPage.Choice) = unsourced.settled(choice)

    private val drawsRim: Boolean get() = !GlassShaders.rim.failed && LiquidGlassRules.rimWanted(Build.VERSION.SDK_INT, isClassic, GlassLaunch.flat, blurs = !lookIsOff && !budgetDegraded)

    override fun update() {
        val classic = isClassic
        val shadows = classic && barShadow
        elevation = if (shadows) GlassRules.CLASSIC_SHADOW_ELEVATION_DP * density else 0f
        if (shadows) {
            val shadow = GlassRules.classicShadow(isDark)
            outlineSpotShadowColor = shadow
            outlineAmbientShadowColor = shadow
        }
        invalidateOutline()
        super.update()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        invalidateOutline()
        backdrop?.invalidate()
    }

    internal var backdrop: GlassBackdropView? = null
        private set

    private var drawingHosted = false

    override fun invalidate() {
        val host = backdrop
        if (host != null) host.invalidate() else super.invalidate()
    }

    internal fun backdropGone(host: GlassBackdropView) {
        if (backdrop !== host) return
        backdrop = null
        super.invalidate()
    }

    internal fun drawHosted(canvas: Canvas) {
        drawingHosted = true
        try {
            drawSafely(canvas)
        } finally {
            drawingHosted = false
        }
    }

    internal fun hostedBy(host: GlassBackdropView) {
        if (backdrop === host) return
        backdrop?.release(this)
        backdrop = host
        host.host(this)
        super.invalidate()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        GlassBackdropView.under(this)?.let(::hostedBy)
        lastChoice?.let(unsourced::settled)
    }

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        if (isVisible) lastChoice?.let(unsourced::settled)
    }

    override fun onDetachedFromWindow() {
        backdrop?.let {
            backdrop = null
            it.release(this)
        }
        unsourced.stop()
        fader?.cancel()
        fader = null
        if (shown) surfaceAlpha = 1f
        super.onDetachedFromWindow()
    }

    private fun showSurface(wasShown: Boolean) {
        fader?.cancel()
        fader = null
        if (GlassRules.fadesIn(wasShown, shown, isAttachedToWindow, shownMs, ValueAnimator.areAnimatorsEnabled())) {
            fader = ValueAnimator.ofFloat(surfaceAlpha.coerceAtMost(1f), 1f).apply {
                duration = shownMs.roundToInt().toLong()
                interpolator = DecelerateInterpolator()
                addUpdateListener { animation ->
                    surfaceAlpha = animation.animatedValue as Float
                    invalidate()
                }
                start()
            }
        } else {
            surfaceAlpha = if (shown) 1f else 0f
            invalidate()
        }
    }

    override fun drawLook(canvas: Canvas) {
        if (backdrop != null && !drawingHosted) return
        val alpha = surfaceAlpha
        if (alpha <= 0f) return
        radiusPx = GlassRules.radiusDp(shape, glassCornerRadius, width / density, height / density) * density
        cornerRadius = radiusPx / density
        val layered = alpha < 1f
        val saved = if (layered) canvas.saveLayerAlpha(0f, 0f, width.toFloat(), height.toFloat(), (alpha * 255).roundToInt()) else -1
        try {
            if (isClassic) drawClassic(canvas) else drawGlass(canvas)
        } finally {
            if (layered) canvas.restoreToCount(saved)
        }
    }

    private fun drawGlass(canvas: Canvas) {
        super.drawLook(canvas)
        box.set(0f, 0f, width.toFloat(), height.toFloat())
        outlinePath.reset()
        outlinePath.addRoundRect(box, radiusPx, radiusPx, Path.Direction.CW)
        tint?.let { tinting ->
            paint.style = Paint.Style.FILL
            paint.color = tinting
            canvas.drawPath(outlinePath, paint)
        }
        if (drawsRim && canvas.isHardwareAccelerated) drawRim(canvas)
    }

    private fun drawRim(canvas: Canvas) {
        if (Build.VERSION.SDK_INT < LiquidGlassRules.LENS_MIN_SDK) return
        val shader = rimShader ?: GlassShaders.rim.attempt { (GlassShaders.makeRim ?: LiquidGlassShaders::rim)() }?.also {
            rimShader = it
            rimPaint.shader = it
            rimPaint.blendMode = BlendMode.PLUS
        } ?: return
        val rim = LiquidGlassRules.rim(width, height, radiusPx, density, isDark)
        if (rim != rimDrawn) {
            GlassShaders.rim.attempt { LiquidGlassShaders.apply(shader, rim) } ?: return
            rimPaint.shader = shader
            rimDrawn = rim
        }
        canvas.drawPath(outlinePath, rimPaint)
    }

    private fun drawClassic(canvas: Canvas) {
        val dark = isDark
        box.set(0f, 0f, width.toFloat(), height.toFloat())
        outlinePath.reset()
        outlinePath.addRoundRect(box, radiusPx, radiusPx, Path.Direction.CW)
        paint.style = Paint.Style.FILL
        paint.color = GlassRules.classicFill(tinted, dark, look.surface.resolve(dark).toArgb(), classicFill)
        canvas.drawPath(outlinePath, paint)
        val edge = GlassRules.CLASSIC_EDGE_DP * density
        box.inset(edge / 2f, edge / 2f)
        outlinePath.reset()
        outlinePath.addRoundRect(box, (radiusPx - edge / 2f).coerceAtLeast(0f), (radiusPx - edge / 2f).coerceAtLeast(0f), Path.Direction.CW)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = edge
        paint.color = GlassRules.classicEdge(dark)
        canvas.drawPath(outlinePath, paint)
    }
}

internal object GlassAttachment {
    var backdrops = 0
        private set
    var hosted = 0
        private set

    fun backdrops(change: Int) {
        backdrops += change
        count("ardiaGlassBackdrops", backdrops)
    }

    fun hosted(change: Int) {
        if (change == 0) return
        hosted += change
        count("ardiaGlassHosted", hosted)
    }

    private fun count(name: String, value: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && android.os.Trace.isEnabled()) android.os.Trace.setCounter(name, value.toLong())
    }
}

class GlassBackdropView(context: Context, appContext: AppContext) : ExpoView(context, appContext), ReactPointerEventsView {
    override val pointerEvents: PointerEvents get() = PointerEvents.NONE

    private val hosted = ArrayList<GlassView>()
    private val drawn = HashMap<GlassView, Placement>()
    private val global = Matrix()
    private val own = Matrix()
    private val ownInverse = Matrix()

    internal val glasses: List<GlassView> get() = hosted.toList()

    internal data class Placement(val matrix: FloatArray, val alpha: Float, val width: Int, val height: Int) {
        override fun equals(other: Any?): Boolean = other is Placement && alpha == other.alpha && width == other.width && height == other.height && matrix.contentEquals(other.matrix)
        override fun hashCode(): Int = ((31 * matrix.contentHashCode() + alpha.hashCode()) * 31 + width) * 31 + height
    }

    init {
        setWillNotDraw(false)
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }

    internal fun host(glass: GlassView) {
        if (glass in hosted) return
        hosted += glass
        hosted.sortWith(GlassBackdropView::treeOrder)
        GlassAttachment.hosted(1)
        invalidate()
    }

    internal fun release(glass: GlassView) {
        if (!hosted.remove(glass)) return
        drawn.remove(glass)
        GlassAttachment.hosted(-1)
        invalidate()
    }

    internal var placementsChecked = 0
        private set

    internal val parked: Boolean get() = drawn.isEmpty() && hosted.none { it.samplesNow }

    private val moved = ViewTreeObserver.OnPreDrawListener {
        if (!parked && hosted.any { placement(it) != drawn[it] }) invalidate()
        true
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        viewTreeObserver.addOnPreDrawListener(moved)
        GlassAttachment.backdrops(1)
        adoptGlassesAfter()
    }

    private fun adoptGlassesAfter() {
        val parent = parent as? android.view.ViewGroup ?: return
        for (index in parent.indexOfChild(this) + 1 until parent.childCount) adoptIn(parent.getChildAt(index))
    }

    private fun adoptIn(view: View) {
        if (view is GlassView && view.isAttachedToWindow && under(view) === this) view.hostedBy(this)
        if (view is android.view.ViewGroup) for (index in 0 until view.childCount) adoptIn(view.getChildAt(index))
    }

    override fun onDetachedFromWindow() {
        viewTreeObserver.removeOnPreDrawListener(moved)
        drawn.clear()
        val left = hosted.toList()
        hosted.clear()
        GlassAttachment.hosted(-left.size)
        GlassAttachment.backdrops(-1)
        left.forEach { it.backdropGone(this) }
        super.onDetachedFromWindow()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

    internal fun placement(glass: GlassView): Placement? {
        placementsChecked += 1
        if (!glass.samplesNow || glass.width <= 0 || glass.height <= 0) return null
        val stop = parent
        var alpha = 1f
        var view: View? = glass
        while (view != null && view !== stop) {
            alpha *= view.alpha * view.transitionAlpha
            view = view.parent as? View
        }
        if (alpha <= 0f) return null
        global.reset()
        glass.transformMatrixToGlobal(global)
        own.reset()
        transformMatrixToGlobal(own)
        if (!own.invert(ownInverse)) return null
        global.postConcat(ownInverse)
        val values = FloatArray(9)
        global.getValues(values)
        return Placement(values, alpha, glass.width, glass.height)
    }

    override fun onDraw(canvas: Canvas) {
        canvas.clipRect(0, 0, width, height)
        val matrix = Matrix()
        for (glass in hosted) {
            val place = placement(glass)
            if (place == null) {
                drawn.remove(glass)
                continue
            }
            drawn[glass] = place
            matrix.setValues(place.matrix)
            val saved = canvas.save()
            try {
                canvas.concat(matrix)
                if (place.alpha < 1f) canvas.saveLayerAlpha(0f, 0f, glass.width.toFloat(), glass.height.toFloat(), (place.alpha * 255).roundToInt())
                glass.drawHosted(canvas)
            } finally {
                canvas.restoreToCount(saved)
            }
        }
    }

    companion object {
        fun under(glass: View): GlassBackdropView? {
            var child: View = glass
            var parent = glass.parent as? android.view.ViewGroup
            while (parent != null) {
                val at = parent.indexOfChild(child)
                for (index in 0 until at) {
                    val sibling = parent.getChildAt(index)
                    if (sibling is GlassBackdropView) return sibling
                }
                child = parent
                parent = parent.parent as? android.view.ViewGroup
            }
            return null
        }

        private fun path(view: View): List<Int> {
            val indices = ArrayList<Int>()
            var child = view
            var parent = view.parent as? android.view.ViewGroup
            while (parent != null) {
                indices += parent.indexOfChild(child)
                child = parent
                parent = parent.parent as? android.view.ViewGroup
            }
            return indices.asReversed()
        }

        fun treeOrder(a: View, b: View): Int {
            val first = path(a)
            val second = path(b)
            for (index in 0 until minOf(first.size, second.size)) {
                val compared = first[index].compareTo(second[index])
                if (compared != 0) return compared
            }
            return first.size.compareTo(second.size)
        }
    }
}
