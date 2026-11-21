package com.ardia.phone

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Outline
import android.view.View
import android.view.ViewOutlineProvider
import android.view.animation.LinearInterpolator
import com.facebook.react.uimanager.PointerEvents
import com.facebook.react.uimanager.ReactPointerEventsView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class MotionTargetRecord : Record {
    @Field val opacity: Double = 1.0
    @Field val translateX: Double = 0.0
    @Field val translateY: Double = 0.0
    @Field val scale: Double = 1.0
    @Field val cornerRadius: Double? = null

    fun values(): MotionValues = MotionValues(opacity.toFloat(), translateX.toFloat(), translateY.toFloat(), scale.toFloat(), cornerRadius?.toFloat())
}

class MotionCurveRecord : Record {
    @Field val type: String = "timing"
    @Field val durationMs: Double = 0.0
    @Field val curve: List<Double>? = null
    @Field val response: Double = 0.3
    @Field val dampingFraction: Double = 1.0

    fun curve(): MotionCurve = if (type == "spring") MotionCurve.Spring(response, dampingFraction) else MotionCurve.Timing(durationMs.toLong(), curve?.map { it.toFloat() })
}

class MotionView(context: Context, appContext: AppContext) : ExpoView(context, appContext), MotionSurface, ReactPointerEventsView {
    override var pointerEvents: PointerEvents = PointerEvents.AUTO
        private set

    fun takePointerEvents(value: String?) {
        pointerEvents = runCatching { PointerEvents.parsePointerEvents(value) }.getOrDefault(PointerEvents.AUTO)
    }

    private val onMotionEnd by EventDispatcher()
    private val onMotionNearEnd by EventDispatcher()
    private val runner = MotionRunner(this).apply {
        onEnd = { finished -> onMotionEnd(mapOf("finished" to finished)) }
        onNearEnd = { remaining -> onMotionNearEnd(mapOf("remainingPx" to remaining.toDouble())) }
        if (PhoneLab.isOn) trace = { line -> lab(line) }
    }
    private var shownAt = 0L
    private var drawsToLog = 0
    private val density = resources.displayMetrics.density
    private var radius: Float? = null
    private var pendingTarget: MotionValues? = null
    private var pendingStart: MotionValues? = null
    private var pendingCurve: MotionCurve = MotionCurve.Timing(0, null)

    private val corners = object : ViewOutlineProvider() {
        override fun getOutline(view: View, outline: Outline) {
            outline.setRoundRect(0, 0, view.width, view.height, (radius ?: 0f) * density)
        }
    }

    fun target(values: MotionValues) {
        pendingTarget = values
    }

    fun start(values: MotionValues?) {
        pendingStart = values
    }

    fun nearEnd(pixels: Double?) {
        runner.nearEndPx = pixels?.toFloat()?.takeIf { it >= 0f }
    }

    fun curve(curve: MotionCurve) {
        pendingCurve = curve
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

    fun applyProps() {
        val next = pendingTarget ?: return
        if (PhoneLab.isOn && next != runner.shown) {
            shownAt = android.os.SystemClock.uptimeMillis()
            drawsToLog = LOGGED_DRAWS
        }
        runner.show(next, pendingCurve, pendingStart)
    }

    override val animates: Boolean get() = isAttachedToWindow && motionEnabled

    override val motionEnabled: Boolean get() = ValueAnimator.areAnimatorsEnabled()

    override fun set(values: MotionValues, channels: Set<MotionChannel>) {
        if (MotionChannel.Opacity in channels) alpha = values.opacity
        if (MotionChannel.TranslateX in channels) translationX = values.translateX * density
        if (MotionChannel.TranslateY in channels) translationY = values.translateY * density
        if (MotionChannel.Scale in channels) {
            scaleX = values.scale
            scaleY = values.scale
        }
        if (MotionChannel.CornerRadius in channels && values.cornerRadius != null) {
            radius = values.cornerRadius
            if (outlineProvider !== corners) outlineProvider = corners
            clipToOutline = true
            invalidateOutline()
        }
    }

    override fun startRenderThread(targets: Map<MotionChannel, Float>, curve: MotionCurve) {
        if (targets.isEmpty()) return
        val animation = animate().setDuration(curve.durationMillis).setInterpolator(curve.interpolator)
        targets[MotionChannel.Opacity]?.let { animation.alpha(it) }
        targets[MotionChannel.TranslateX]?.let { animation.translationX(it * density) }
        targets[MotionChannel.TranslateY]?.let { animation.translationY(it * density) }
        targets[MotionChannel.Scale]?.let {
            animation.scaleX(it)
            animation.scaleY(it)
        }
        animation.start()
    }

    override fun cancelRenderThread() = animate().cancel()

    override fun pixels(channel: MotionChannel, change: Float): Float = when (channel) {
        MotionChannel.TranslateX, MotionChannel.TranslateY, MotionChannel.CornerRadius -> change * density
        MotionChannel.Scale -> change * reach() / 2f
        MotionChannel.Opacity -> change * OPACITY_STEPS
    }

    private fun reach(): Float {
        val laidOut = maxOf(width, height)
        if (laidOut > 0) return laidOut.toFloat()
        val screen = resources.displayMetrics
        return maxOf(screen.widthPixels, screen.heightPixels).toFloat()
    }

    override fun startClock(durationMillis: Long, onFrame: (Float) -> Unit, onEnd: (Boolean) -> Unit): MotionClock {
        val animator = ValueAnimator.ofFloat(0f, 1f).setDuration(durationMillis)
        animator.interpolator = LinearInterpolator()
        var cancelled = false
        animator.addUpdateListener { onFrame(it.animatedFraction) }
        animator.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationCancel(animation: Animator) {
                cancelled = true
            }

            override fun onAnimationEnd(animation: Animator) = onEnd(!cancelled)
        })
        animator.start()
        return object : MotionClock {
            override val fraction: Float get() = if (durationMillis <= 0) 1f else (animator.currentPlayTime.toFloat() / durationMillis).coerceIn(0f, 1f)

            override fun cancel() = animator.cancel()
        }
    }

    override fun onDetachedFromWindow() {
        if (PhoneLab.isOn) {
            if (runner.shown != null) lab("detached")
            viewTreeObserver.removeOnPreDrawListener(framesLogged)
        }
        runner.interrupt()
        super.onDetachedFromWindow()
    }

    private val framesLogged = android.view.ViewTreeObserver.OnPreDrawListener {
        if (drawsToLog > 0) {
            drawsToLog -= 1
            lab("frame ${android.os.SystemClock.uptimeMillis() - shownAt} ms after its props: ${width}x$height at scale ${"%.4f".format(scaleX)}, translation ${translationX.toInt()},${translationY.toInt()}, pivot ${pivotX.toInt()},${pivotY.toInt()}, alpha ${"%.2f".format(alpha)}${if (isAttachedToWindow) "" else ", not attached"}")
        }
        true
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (PhoneLab.isOn) {
            lab("attached ${android.os.SystemClock.uptimeMillis() - shownAt} ms after its props, ${width}x$height")
            viewTreeObserver.addOnPreDrawListener(framesLogged)
        }
    }

    private fun lab(line: String) = android.util.Log.i("PAGELAB", "PAGELAB motion view $id: $line")

    private companion object {
        const val OPACITY_STEPS = 255f
        const val LOGGED_DRAWS = 8
    }
}

class MotionModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneMotion")

        Constants("runsInRenderServer" to true)

        View(MotionView::class) {
            Events("onMotionEnd", "onMotionNearEnd")

            Prop("to") { view: MotionView, target: MotionTargetRecord -> view.target(target.values()) }

            Prop("from") { view: MotionView, start: MotionTargetRecord? -> view.start(start?.values()) }

            Prop("motion") { view: MotionView, curve: MotionCurveRecord -> view.curve(curve.curve()) }

            Prop("nearEndPx") { view: MotionView, pixels: Double? -> view.nearEnd(pixels) }

            Prop("pointerEvents") { view: MotionView, value: String? -> view.takePointerEvents(value) }

            OnViewDidUpdateProps { view: MotionView -> view.applyProps() }
        }
    }
}
