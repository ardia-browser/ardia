package com.ardia.phone

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.webkit.WebView
import android.widget.FrameLayout
import com.ardia.browser.BrowserUrl
import com.ardia.browser.Page
import com.ardia.browser.PageColors
import com.ardia.browser.PageState
import com.ardia.browser.ErrorPages
import com.ardia.browser.PageTone
import com.ardia.browsing.PageDocument
import com.ardia.browsing.PagePinch
import com.ardia.browsing.SwipeDirection
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

class PageView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private val onPageEvent by EventDispatcher()
    private val host = FrameLayout(context)
    private var scope: CoroutineScope? = null
    private var sampled: PageTone? = null
    private var sampledDocument = -1L
    private var sentTone: PageTone? = null
    private var toneSampledSinceBind = false
    private var failedId: String? = null
    private var document = PageDocument()
    private val summaryPresenter = PageSummaryPresenter().also { it.onClose = { dismissSummary(animated = true) } }
    private var summaryLayer: View? = null
    private var summaryWatch: Job? = null
    private var touchesSummary = false
    private val hideSummary = Runnable { if (!summaryPresenter.shown) hideSummaryNow() }

    var pageId: String? = null
    var initialUrl: String? = null
    var title: String? = null
    var isPrivate: Boolean = false
    var savedState: String? = null
    var toneInsets: Pair<Double, Double> = 0.0 to 0.0
    var obscuredInsets: Pair<Double, Double> = 0.0 to 0.0
    var bottomInsetTransitionMs = 0
    var summaryBottomInset: Double = 0.0
        set(value) {
            if (field == value) return
            field = value
            if (summaryLayer?.visibility == View.VISIBLE) layOutChildren()
        }
    private var appliedObscuredInsets: Pair<Double, Double> = 0.0 to 0.0
    private val insetSettlement = PageInsetSettlement()
    private var insetPage: Page? = null
    private var insetWeb: WebView? = null
    private var observedWeb: WebView? = null
    private var observedScrollX = 0
    private var observedScrollY = 0
    private val settleInsets = object : Runnable {
        override fun run() {
            if (!isAttachedToWindow || insetPage !== page || insetWeb !== PageDrawnWatch.webViewIn(host)) return
            val remaining = insetSettlement.remaining(SystemClock.uptimeMillis(), bottomInsetTransitionMs.toLong())
            if (remaining > 0) postDelayed(this, remaining) else applyObscuredInsets()
        }
    }
    private val pageScrolled = ViewTreeObserver.OnScrollChangedListener {
        val web = PageDrawnWatch.webViewIn(host)
        val x = web?.scrollX ?: 0
        val y = web?.scrollY ?: 0
        if (web === observedWeb && (x != observedScrollX || y != observedScrollY)) insetSettlement.scrolled(SystemClock.uptimeMillis())
        observedWeb = web
        observedScrollX = x
        observedScrollY = y
    }
    var obscuredColours: Pair<Int?, Int?> = null to null
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }
    private val bandPaint = Paint()
    var page: Page? = null
        private set

    private val gestures = PageGestures(this, host).apply {
        onSwipedPastHistory = { direction -> onPageEvent(mapOf("name" to "swipedPastHistory", "direction" to if (direction == SwipeDirection.Back) "back" else "forward")) }
    }

    private val pinches = PagePinchWatcher(
        density = context.resources.displayMetrics.density,
        isOn = { PageSummaryChoice.isEnabled(context) },
        moment = ::pinchMoment,
        measureRest = ::measureRest,
        later = { millis, run -> postDelayed({ run() }, millis) },
    ) {
        if (summarize(PageSummarySession.Trigger.Pinch)) performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
    }

    var swipeMode: SwipeMode
        get() = gestures.mode
        set(value) {
            gestures.mode = value
        }

    var closesOnSwipeBack: Boolean
        get() = gestures.closesPastBack
        set(value) {
            gestures.closesPastBack = value
        }

    var reopensOnSwipeForward: Boolean
        get() = gestures.reopensPastForward
        set(value) {
            gestures.reopensPastForward = value
        }

    var pullToRefresh: Boolean
        get() = gestures.pullToRefresh
        set(value) {
            gestures.pullToRefresh = value
        }

    var surfaceColor: Int?
        get() = gestures.surfaceColor
        set(value) {
            gestures.surfaceColor = value
        }

    private var drawnAskedAt = 0L

    private val drawn = PageDrawnWatch(
        object : DrawnSurface {
            override fun visible() = isShown && width > 0 && height > 0 && PageDrawnWatch.shownAlpha(this@PageView) > 0f

            override fun postVisualState(done: () -> Unit): Boolean {
                val web = PageDrawnWatch.webViewIn(host) ?: return false
                drawnAskedAt = SystemClock.uptimeMillis()
                web.postVisualStateCallback(
                    drawnAskedAt,
                    object : WebView.VisualStateCallback() {
                        override fun onComplete(requestId: Long) = done()
                    },
                )
                return true
            }

            override fun afterNextFrameCommits(done: () -> Unit) {
                viewTreeObserver.registerFrameCommitCallback { done() }
                (PageDrawnWatch.webViewIn(host) ?: this@PageView).invalidate()
            }
        },
    ) {
        cover.pageDrawn()
        lab { "page view ${page?.id ?: pageId} drawn ${SystemClock.uptimeMillis() - drawnAskedAt} ms after it became visible" }
        onPageEvent(mapOf("name" to "drawn"))
    }

    private val cover = CoverHandOver(
        object : CoverSurface {
            override fun find(nativeId: String): View? = com.facebook.react.uimanager.util.ReactFindViewUtil.findView(rootView, nativeId)

            override fun schedule(millis: Long, run: () -> Unit): () -> Unit {
                val task = Runnable(run)
                postDelayed(task, millis)
                return { removeCallbacks(task) }
            }
        },
    ) { reason, found ->
        lab { "page view ${page?.id ?: pageId} hid its cover on ${if (reason == CoverHandOver.REASON_CAP) "the ${CoverHandOver.CAP_MILLIS} ms cap" else "its first drawn frame"}${if (found) "" else ", but no view had that nativeID"}" }
        onPageEvent(mapOf("name" to "coverHidden", "reason" to reason, "found" to found))
    }

    var coverNativeId: String?
        get() = cover.nativeId
        set(value) = cover.cover(value)

    internal fun bands(): PageBands.Frame {
        val density = resources.displayMetrics.density
        return PageBands.frame(height, (appliedObscuredInsets.first * density).roundToInt(), (appliedObscuredInsets.second * density).roundToInt())
    }

    internal fun bandColours(): Pair<Int?, Int?> = PageBands.colour(obscuredColours.first, surfaceColor) to PageBands.colour(obscuredColours.second, surfaceColor)

    internal fun croppedToneInsets(): Pair<Double, Double> {
        val density = resources.displayMetrics.density
        val bands = bands()
        val (top, bottom) = PageBands.toneOffsets((toneInsets.first * density).roundToInt() to (toneInsets.second * density).roundToInt(), bands)
        return top / density.toDouble() to bottom / density.toDouble()
    }

    override fun dispatchDraw(canvas: Canvas) {
        val bands = bands()
        if (!bands.isEmpty) {
            val (top, bottom) = bandColours()
            if (bands.top > 0 && top != null) {
                bandPaint.color = top
                canvas.drawRect(0f, 0f, width.toFloat(), bands.top.toFloat(), bandPaint)
            }
            if (bands.bottom > 0 && bottom != null) {
                bandPaint.color = bottom
                canvas.drawRect(0f, (height - bands.bottom).toFloat(), width.toFloat(), height.toFloat(), bandPaint)
            }
        }
        super.dispatchDraw(canvas)
    }

    init {
        setWillNotDraw(false)
        drawn.onVisible = { cover.pageVisible() }
        addView(host, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        gestures.install()
    }

    override fun requestDisallowInterceptTouchEvent(disallow: Boolean) {
        super.requestDisallowInterceptTouchEvent(disallow)
        if (disallow) gestures.contentTookTheDrag()
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        val action = event.actionMasked
        if (action == MotionEvent.ACTION_DOWN) touchesSummary = isOnSummary(event.x, event.y)
        if (!touchesSummary) pinches.observe(event)
        val handled = super.dispatchTouchEvent(event)
        when (action) {
            MotionEvent.ACTION_DOWN -> insetSettlement.touching = handled && !touchesSummary
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> insetSettlement.touching = false
        }
        return handled
    }

    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
        if (touchesSummary) return super.onInterceptTouchEvent(event)
        return gestures.intercepts(event) || super.onInterceptTouchEvent(event)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean = gestures.touch(event) || super.onTouchEvent(event)

    fun bind() {
        val id = pageId ?: return
        if (page?.id == id || failedId == id) return
        unbind()
        val opened = try {
            PhonePages.open(context, id, PhonePages.setup(initialUrl, title, isPrivate, savedState))
        } catch (error: CodedException) {
            failedId = id
            onPageEvent(mapOf("name" to "error", "code" to error.code, "message" to (error.message ?: error.code)))
            return
        }
        page = opened
        document = PageDocument()
        toneSampledSinceBind = false
        gestures.page = opened
        PhonePages.viewShows(id, this)
        val running = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        scope = running
        running.launch { opened.view.collect(::show) }
        running.launch { opened.state.collect(::sendState) }
        running.launch { sampleTone(opened) }
    }

    fun unbind() {
        cancelInsetSettlement()
        observedWeb = null
        insetSettlement.touching = false
        appliedObscuredInsets = obscuredInsets
        dismissSummary(animated = false)
        cover.cancel()
        drawn.reset()
        page?.id?.let { PhonePages.viewLeaves(it, this) }
        scope?.cancel()
        scope = null
        page = null
        gestures.page = null
        gestures.detach()
        failedId = null
        sampled = null
        sentTone = null
        toneSampledSinceBind = false
        host.removeAllViews()
    }

    private val asksWhenShown = android.view.ViewTreeObserver.OnPreDrawListener {
        if (PhonePages.permissionAsks.pending > 0) PhonePages.permissionAsks.pump()
        drawn.frame()
        true
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        page?.id?.let(PhonePages::activate)
        viewTreeObserver.addOnPreDrawListener(asksWhenShown)
        viewTreeObserver.addOnScrollChangedListener(pageScrolled)
        applyObscuredInsets()
    }

    override fun onDetachedFromWindow() {
        dismissSummary(animated = false)
        viewTreeObserver.removeOnPreDrawListener(asksWhenShown)
        viewTreeObserver.removeOnScrollChangedListener(pageScrolled)
        cancelInsetSettlement()
        insetSettlement.touching = false
        cover.cancel()
        drawn.reset()
        super.onDetachedFromWindow()
    }

    private fun show(view: View?) {
        if (view != null && view.parent === host && host.childCount == 1) return
        applyObscuredInsets()
        observedWeb = null
        documentChanged(document.replaced())
        val hadView = host.childCount > 0
        host.removeAllViews()
        drawn.reset()
        if (view == null) {
            if (hadView) lab { "page view ${page?.id ?: pageId} lost its WebView (the page released it), ${width}x$height" }
            return
        }
        val owner = view.parent as? ViewGroup
        owner?.removeView(view)
        host.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        layOutChildren()
        lab {
            val from = if (owner != null) ", taken from another view (${owner.javaClass.simpleName}${(owner.parent as? PageView)?.let { " of page view ${it.pageId}" } ?: ""})" else ""
            "page view ${page?.id ?: pageId} shows its WebView at ${width}x$height, ${if (isShown) "shown" else "not shown"}$from"
        }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        applyObscuredInsets()
        lab { "page view ${page?.id ?: pageId} size ${oldw}x$oldh -> ${w}x$h" }
    }

    private inline fun lab(line: () -> String) {
        if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB ${line()}")
    }

    private val layOutAgain = Runnable {
        if (summaryLayer?.visibility == View.VISIBLE && isAttachedToWindow && isLaidOut && isLayoutRequested) {
            measureAndLayout()
        } else {
            layOutChildren()
        }
    }

    fun updateObscuredInsets() {
        if (appliedObscuredInsets == obscuredInsets) {
            cancelInsetSettlement()
            return
        }
        val web = PageDrawnWatch.webViewIn(host)
        val defers = bottomInsetTransitionMs > 0 && appliedObscuredInsets.first == obscuredInsets.first &&
            appliedObscuredInsets.second > 0 && obscuredInsets.second > 0 && page?.id == pageId && web != null && isAttachedToWindow
        if (!defers) {
            applyObscuredInsets()
            return
        }
        if (insetPage === page && insetWeb === web && insetSettlement.target == obscuredInsets.second) return
        removeCallbacks(settleInsets)
        insetPage = page
        insetWeb = web
        insetSettlement.changed(obscuredInsets.second, SystemClock.uptimeMillis())
        postDelayed(settleInsets, bottomInsetTransitionMs.toLong())
    }

    private fun cancelInsetSettlement() {
        removeCallbacks(settleInsets)
        insetPage = null
        insetWeb = null
        insetSettlement.reset()
    }

    private fun applyObscuredInsets() {
        cancelInsetSettlement()
        if (appliedObscuredInsets == obscuredInsets) return
        lab { "page view ${page?.id ?: pageId} bottom inset ${appliedObscuredInsets.second} -> ${obscuredInsets.second}" }
        appliedObscuredInsets = obscuredInsets
        layOutChildren()
        invalidate()
    }

    private fun layOutChildren() {
        if (width == 0 || height == 0) return
        placeHost(width, height)
    }

    private fun placeHost(width: Int, height: Int) {
        val bands = PageBands.frame(height, (appliedObscuredInsets.first * resources.displayMetrics.density).roundToInt(), (appliedObscuredInsets.second * resources.displayMetrics.density).roundToInt())
        val pageHeight = height - bands.top - bands.bottom
        if (host.isLayoutRequested || host.measuredWidth != width || host.measuredHeight != pageHeight || host.width != width || host.height != pageHeight || host.top != bands.top || host.bottom != bands.top + pageHeight) {
            host.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(pageHeight, MeasureSpec.EXACTLY))
            host.layout(0, bands.top, width, bands.top + pageHeight)
        }
        gestures.layout(width, height, bands.top)
        layOutSummary(width, height, bands)
    }

    override fun requestLayout() {
        super.requestLayout()
        @Suppress("SENSELESS_COMPARISON")
        if (layOutAgain != null) {
            removeCallbacks(layOutAgain)
            post(layOutAgain)
        }
    }

    private fun sendState(state: PageState) {
        documentChanged(document.saw(state.url, state.isLoading))
        onPageEvent(present(mapOf("name" to "state") + PagePayloads.state(context, state, page?.isPrivate ?: isPrivate)))
        sendTone(state)
    }

    private fun present(fields: Map<String, Any?>): Map<String, Any> = buildMap { fields.forEach { (key, value) -> if (value != null) put(key, value) } }

    private fun sendTone(state: PageState) {
        if (state.failure != null) sampled = null
        if (!PageToneGate.reports(state.themeColor, state.failure != null, toneSampledSinceBind)) return
        val tone = ErrorPages.tone(state.failure, PageTone.resolve(state.themeColor, state.backgroundColor, sampled, stored = null))
        if (tone == sentTone || (tone.top == null && tone.bottom == null && sentTone == null)) return
        sentTone = tone
        onPageEvent(
            buildMap {
                put("name", "tone")
                tone.top?.let { put("top", PageColors.hex(it)) }
                tone.bottom?.let { put("bottom", PageColors.hex(it)) }
            },
        )
    }

    private suspend fun sampleTone(page: Page) {
        page.state.map { Triple(it.isLoading, it.scrollDirection, it.isScrolledToTop) }.distinctUntilChanged().collectLatest { (loading, _, _) ->
            if (loading) return@collectLatest
            delay(TONE_SETTLE_MILLIS)
            val density = resources.displayMetrics.density
            val (top, bottom) = PageBands.toneOffsets((toneInsets.first * density).roundToInt() to (toneInsets.second * density).roundToInt(), bands())
            val taken = page.sampleTone(top, bottom)
            toneSampledSinceBind = true
            if (taken != null) {
                sampled = taken.over(sampled.takeIf { sampledDocument == document.generation })
                sampledDocument = document.generation
            }
            sendTone(page.state.value)
        }
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        placeHost(r - l, b - t)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        val bands = PageBands.frame(measuredHeight, (appliedObscuredInsets.first * resources.displayMetrics.density).roundToInt(), (appliedObscuredInsets.second * resources.displayMetrics.density).roundToInt())
        host.measure(
            MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(measuredHeight - bands.top - bands.bottom, MeasureSpec.EXACTLY),
        )
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (!isShown) dismissSummary(animated = false)
    }

    private fun documentChanged(generation: Long) {
        val session = summaryPresenter.session ?: return
        if (session.document == generation) return
        dismissSummary(animated = false)
    }

    private fun pinchMoment(): PagePinch.Moment? {
        val opened = page ?: return null
        val web = PageDrawnWatch.webViewIn(host) ?: return null
        if (opened.view.value !== web) return null
        val state = opened.state.value
        val visible = isAttachedToWindow && isShown && width > 0 && height > 0 && web.isShown && PageDrawnWatch.shownAlpha(this) > 0f &&
            state.failure == null && state.url?.let(BrowserUrl::isWeb) == true
        @Suppress("DEPRECATION")
        val scale = web.scale
        return PagePinch.Moment(opened.id, document.generation, scale, visible, state.isLoading, gestures.isDragging)
    }

    private fun measureRest(done: (Boolean, Float) -> Unit) {
        val web = PageDrawnWatch.webViewIn(host) ?: return done(false, Float.NaN)
        web.evaluateJavascript(PagePinch.VIEWPORT_SCRIPT) { result ->
            @Suppress("DEPRECATION")
            val scale = web.scale
            done(PagePinch.restsAtMinimum(result) && PageDrawnWatch.webViewIn(host) === web, scale)
        }
    }

    internal fun summarize(trigger: PageSummarySession.Trigger): Boolean {
        if (!PageSummaryChoice.isEnabled(context)) return false
        val opened = page ?: return false
        val moment = pinchMoment() ?: return false
        if (!moment.isVisible || moment.isLoading) return false
        val generation = document.generation
        summaryPresenter.session?.let { current ->
            if (current.pageId == opened.id && current.document == generation && summaryPresenter.shown && current.phase !is PageSummarySession.Phase.Failed) return true
        }
        dismissSummary(animated = false)
        val web = opened.view.value
        val account = BrowseForMeHost.get(context).account
        val provider = PageSummaryChoice.stored(context)
        val revision = PageSummaryChoice.revision
        val made = PageSummarySession(
            trigger = trigger,
            pageId = opened.id,
            document = generation,
            isPrivate = opened.isPrivate,
            title = opened.state.value.title,
            provider = provider,
            writing = PageSummaryWriting.live(account),
            read = { opened.readableContent() },
            isCurrent = { PageSummaryChoice.revision == revision && page === opened && document.generation == generation && web != null && opened.view.value === web },
        )
        made.onSettled = { settled ->
            PhonePages.report(settled.pageId, "page.summarySettled", "trigger" to settled.trigger.raw, "outcome" to settled.outcome, "chatGPTFellBack" to settled.chatGPTFellBack, "geminiNanoMissing" to settled.geminiNanoMissing, "isPrivate" to settled.isPrivate)
        }
        val layer = ensureSummaryLayer()
        removeCallbacks(hideSummary)
        summaryPresenter.session = made
        summaryPresenter.shown = true
        layer.visibility = View.VISIBLE
        layOutChildren()
        if (made.usesChatGPT) summaryWatch = scope?.launch { account.state.collect { if (!it.isConnected) made.chatGPTDisconnected() } }
        made.start()
        PhonePages.report(opened.id, "page.summaryOpened", "trigger" to trigger.raw, "isPrivate" to opened.isPrivate)
        return true
    }

    fun dismissSummary(animated: Boolean) {
        pinches.reset()
        val session = summaryPresenter.session ?: return
        session.cancel()
        summaryWatch?.cancel()
        summaryWatch = null
        summaryPresenter.cardBounds.setEmpty()
        summaryPresenter.shown = false
        removeCallbacks(hideSummary)
        if (animated) postDelayed(hideSummary, SUMMARY_EXIT_MILLIS) else hideSummaryNow()
    }

    private fun hideSummaryNow() {
        summaryPresenter.session = null
        val layer = summaryLayer ?: return
        summaryLayer = null
        removeView(layer)
    }

    private fun ensureSummaryLayer(): View = summaryLayer ?: pageSummaryLayer(context, summaryPresenter).also { made ->
        made.elevation = SUMMARY_ELEVATION_DP * resources.displayMetrics.density
        made.visibility = View.GONE
        addView(made, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        summaryLayer = made
    }

    private fun isOnSummary(x: Float, y: Float): Boolean {
        val layer = summaryLayer ?: return false
        if (layer.visibility != View.VISIBLE || summaryPresenter.session == null || summaryPresenter.cardBounds.isEmpty) return false
        return summaryPresenter.cardBounds.contains((x - layer.left).toInt(), (y - layer.top).toInt())
    }

    private fun layOutSummary(width: Int, height: Int, bands: PageBands.Frame) {
        val layer = summaryLayer ?: return
        if (layer.visibility == View.GONE) return
        val density = resources.displayMetrics.density
        val placement = PageBands.summaryPlacement(
            height = height,
            density = density,
            bands = bands,
            toneBottomPx = (toneInsets.second * density).roundToInt(),
            summaryBottomPx = (summaryBottomInset * density).roundToInt(),
            marginDp = SUMMARY_MARGIN_DP,
            heightShare = SUMMARY_HEIGHT_SHARE,
            minimumHeightDp = SUMMARY_MINIMUM_HEIGHT_DP,
        )
        if (summaryPresenter.maxHeightDp != placement.maxHeightDp) summaryPresenter.maxHeightDp = placement.maxHeightDp
        layer.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(placement.roomPx, MeasureSpec.AT_MOST))
        val top = height - placement.bottomPx - layer.measuredHeight
        layer.layout(0, top, width, top + layer.measuredHeight)
    }

    private companion object {
        const val TONE_SETTLE_MILLIS = 250L
        const val SUMMARY_EXIT_MILLIS = 300L
        const val SUMMARY_ELEVATION_DP = 16f
        const val SUMMARY_MARGIN_DP = 12f
        const val SUMMARY_HEIGHT_SHARE = 0.45f
        const val SUMMARY_MINIMUM_HEIGHT_DP = 160f
    }
}

internal object PageToneGate {
    fun reports(themeColor: Int?, failed: Boolean, sampledSinceBind: Boolean): Boolean = sampledSinceBind || themeColor != null || failed
}
