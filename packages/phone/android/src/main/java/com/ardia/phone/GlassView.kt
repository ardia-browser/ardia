package com.ardia.phone

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import android.view.ViewOutlineProvider
import android.view.animation.DecelerateInterpolator
import androidx.compose.ui.graphics.toArgb
import expo.modules.kotlin.AppContext
import kotlin.math.min
import kotlin.math.roundToInt

internal object GlassRules {
    const val CLASSIC_EDGE_DP = 0.5f
    const val CLASSIC_SHADOW_ELEVATION_DP = 3f
    const val DEFAULT_SHOWN_MS = 200f
    const val NATIVE_GLASS_ARGUMENT = "ArdiaNativeGlass"

    fun solid(surface: String?, reduceTransparency: Boolean): Boolean = reduceTransparency || surface == "classic"

    fun radiusDp(shape: String?, cornerRadiusDp: Float, widthDp: Float, heightDp: Float): Float =
        if (shape == "rounded") cornerRadiusDp.coerceAtLeast(0f) else min(widthDp, heightDp).coerceAtLeast(0f) / 2f

    fun classicFill(tinted: Boolean, dark: Boolean, lookSurface: Int): Int = when {
        tinted -> lookSurface
        dark -> 0xFF000000.toInt()
        else -> 0xFFFFFFFF.toInt()
    }

    fun classicEdge(dark: Boolean): Int = if (dark) 0x1FFFFFFF else 0x1F000000

    fun classicShadow(dark: Boolean): Int = if (dark) 0x66000000 else 0x1F000000

    fun fadesIn(wasShown: Boolean, shown: Boolean, attached: Boolean, durationMs: Float, animatorsOn: Boolean): Boolean =
        !wasShown && shown && attached && durationMs > 0f && animatorsOn

    fun nativeGlassAsked(arguments: Map<String, Any>): Boolean = arguments[NATIVE_GLASS_ARGUMENT] == true
}

class GlassView(context: Context, appContext: AppContext) : FrostView(context, appContext) {
    var shape: String? = null
    var glassCornerRadius: Float = 0f
    var tint: Int? = null
    var interactive: Boolean = true
    var tinted: Boolean = false
    var barShadow: Boolean = false
    var shownMs: Float = GlassRules.DEFAULT_SHOWN_MS
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
            showSurface(was)
        }

    private var surfaceAlpha = 1f
    private var fader: ValueAnimator? = null
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val box = RectF()
    private val outlinePath = Path()
    private var radiusPx = 0f

    init {
        variant = "glass"
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                outline.setRoundRect(0, 0, view.width, view.height, radiusPx)
            }
        }
    }

    val isClassic: Boolean get() = GlassRules.solid(surface, reduceTransparency)

    override fun canBlur(): Boolean = !isClassic && super.canBlur()

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
    }

    override fun onDetachedFromWindow() {
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
        val tinting = tint ?: return
        paint.style = Paint.Style.FILL
        paint.color = tinting
        box.set(0f, 0f, width.toFloat(), height.toFloat())
        outlinePath.reset()
        outlinePath.addRoundRect(box, radiusPx, radiusPx, Path.Direction.CW)
        canvas.drawPath(outlinePath, paint)
    }

    private fun drawClassic(canvas: Canvas) {
        val dark = isDark
        box.set(0f, 0f, width.toFloat(), height.toFloat())
        outlinePath.reset()
        outlinePath.addRoundRect(box, radiusPx, radiusPx, Path.Direction.CW)
        paint.style = Paint.Style.FILL
        paint.color = GlassRules.classicFill(tinted, dark, look.surface.resolve(dark).toArgb())
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
