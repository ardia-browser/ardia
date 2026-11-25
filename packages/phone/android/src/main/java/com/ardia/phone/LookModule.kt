package com.ardia.phone

import com.ardia.design.Frosting
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

internal object LookThread {
    private val main by lazy { android.os.Handler(android.os.Looper.getMainLooper()) }

    fun onMain(work: () -> Unit) {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) work() else main.post(work)
    }
}

class LookModule : Module() {
    private val systemLook = SystemLookWatch(read = { appContext.reactContext?.let(SystemMotion::read) ?: SystemMotion.unknown }) { now ->
        if (SystemMotion.note(now)) LookThread.onMain { AttachedLookViews.all().forEach { it.invalidate() } }
        if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB look system settings changed while running: reduce motion ${now["reduceMotion"]}, reduce transparency ${now["reduceTransparency"]}")
        runCatching { sendEvent(SYSTEM_LOOK_CHANGED, now) }
    }
    private var systemLookObserver: SystemLookObserver? = null

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneLook")

        Events(SYSTEM_LOOK_CHANGED)

        Function("systemLook") { systemLook.check() }

        Function("hasGlass") {
            readGlassLaunch()
            true
        }

        Function("glassRender") {
            readGlassLaunch()
            val context = appContext.reactContext
            val blurs = Frosting.isBlurSupported && context != null && !LookSwitch.isOff(context) && !LookBudget.isDegraded(context)
            LiquidGlassRules.render(android.os.Build.VERSION.SDK_INT, classic = false, flat = GlassLaunch.flat || GlassShaders.lens.failed, blurs = blurs).raw
        }

        OnCreate {
            val context = appContext.reactContext ?: return@OnCreate
            readGlassLaunch()
            SystemMotion.note(systemLook.seed())
            GlassShaders.onFailed = PendingCounts.glassShaderFailures(context.applicationContext)
            GlassCounts.onUnsourced = PendingCounts.glassUnsourced(context.applicationContext)
            systemLookObserver = SystemLookObserver(context.applicationContext) { systemLook.check() }.also { it.start() }
        }

        OnActivityEntersForeground {
            systemLook.check()
            if (GlassShaders.retryFailed()) AttachedLookViews.all().forEach { it.postInvalidate() }
        }

        OnDestroy { systemLookObserver?.stop() }

        Function("setPageFrost") { mode: String ->
            check(PhoneLab.isOn) { "the page frost mode is a lab switch" }
            FrostSources.pageMode = FrostSources.PageMode.entries.firstOrNull { it.raw == mode } ?: FrostSources.PageMode.Live
            LookThread.onMain {
                FrostSources.frosts().forEach { it.invalidate() }
                FrostSources.allSources().forEach { it.invalidate() }
            }
            FrostSources.pageMode.raw
        }

        Function("setLookOff") { off: Boolean ->
            val context = appContext.reactContext ?: throw IllegalStateException("the app context is gone")
            LookSwitch.set(context, off)
            android.util.Log.i("PAGELAB", "PAGELAB look views ${if (off) "off: flat colours, no blur, grain or motion" else "on"} (takes effect for views drawn from now; force-stop to measure a clean launch)")
            LookThread.onMain {
                AttachedLookViews.all().forEach { it.invalidate() }
                FrostSources.frosts().forEach { it.invalidate() }
                FrostSources.allSources().forEach { it.invalidate() }
            }
            off
        }

        Function("lookBudget") {
            val context = appContext.reactContext ?: throw IllegalStateException("the app context is gone")
            mapOf("state" to LookBudget.state(context), "version" to LookBudget.version(context), "forced" to LookBudget.forced(context))
        }

        Function("setLookBudget") { state: String ->
            val context = appContext.reactContext ?: throw IllegalStateException("the app context is gone")
            LookBudget.save(context, state)
        }

        Function("forceLookBudget") { applied: String? ->
            val context = appContext.reactContext ?: throw IllegalStateException("the app context is gone")
            LookBudget.force(context, applied?.takeIf { it == "full" || it == "degraded" })
            android.util.Log.i("PAGELAB", "PAGELAB look budget ${applied?.let { "forced $it" } ?: "measured again, not forced"} (from the next time the deck is built)")
        }

        AsyncFunction("sampleFrames") { millis: Double, promise: Promise ->
            val activity = appContext.currentActivity
            if (activity == null) {
                promise.resolve(null)
                return@AsyncFunction
            }
            FrameSampler.sample(activity, millis.toLong().coerceIn(100L, 10_000L)) { sample ->
                promise.resolve(sample?.let { mapOf("totals" to it.totals, "deadlines" to it.deadlines, "refreshMs" to it.refreshMillis, "windowMs" to it.windowMillis, "foreignFrames" to it.foreignFrames, "waits" to it.waits, "tickMs" to it.tickMillis, "mainThreadMs" to it.mainThreadMillis, "droppedReports" to it.droppedReports, "sceneWorkerMs" to it.sceneWorkerMillis, "mainThreadMessages" to it.mainThreadMessages, "longestMessages" to it.longestMessages, "sceneCount" to it.sceneCount, "blendCount" to it.blendCount, "foreignViews" to it.foreignViews) })
            }
        }.runOnQueue(Queues.MAIN)

        Function("cancelSampleFrames") {
            android.os.Handler(android.os.Looper.getMainLooper()).post { FrameSampler.cancel() }
            Unit
        }

        Function("lookCounts") {
            val counts = LookMemory.counts()
            mapOf(
                "sources" to counts.sources,
                "recording" to counts.recording,
                "frosts" to counts.frosts,
                "holdingLayers" to counts.holdingLayers,
                "layerBytes" to counts.layerBytes.toDouble(),
                "decks" to counts.decks,
                "animating" to counts.animating,
                "recordingNames" to counts.recordingNames,
                "layerNames" to counts.layerNames,
                "heldStill" to counts.heldStill,
                "tinted" to counts.tinted,
                "backdropFrames" to LookActivity.backdropFrames,
                "sourceRecordings" to LookActivity.sourceRecordings,
                "blurLayerRenders" to LookActivity.blurLayerRenders,
                "stripRecords" to LookActivity.stripRecords,
                "stripRefreshes" to LookActivity.stripRefreshes,
                "strips" to counts.strips,
                "retints" to LookActivity.retints,
                "restingLayerHolds" to LookActivity.restingLayerHolds,
                "restingLayered" to LookActivity.restingLayered,
            )
        }

        Function("setBlobFramesPerSecond") { rate: Int ->
            val context = appContext.reactContext ?: throw IllegalStateException("the app context is gone")
            LookSwitch.setBlobFramesPerSecond(context, rate)
            val kept = LookSwitch.blobFramesPerSecond(context)
            val shown = when {
                kept == LookRules.EVERY_FRAME -> "every frame (as Compose)"
                kept > 0 -> "at $kept fps"
                else -> "paced: a frame each time the fastest blob has moved ${(LookRules.BLOB_STEP_SHARE * 100).toInt()}% of its radius"
            }
            android.util.Log.i("PAGELAB", "PAGELAB look blobs $shown (lasts across launches; force-stop to measure a clean launch)")
            LookThread.onMain { DeckBackdrops.all().forEach { it.invalidate() } }
            kept
        }

        Function("setBlurOverBackdrop") { blur: Boolean ->
            val context = appContext.reactContext ?: throw IllegalStateException("the app context is gone")
            LookSwitch.setBlurOverBackdrop(context, blur)
            android.util.Log.i("PAGELAB", "PAGELAB look frosts over the backdrop alone ${if (blur) "blur it (as before)" else "are fills tinted from it"}")
            LookThread.onMain {
                FrostSources.frosts().forEach { it.invalidate() }
                FrostSources.allSources().forEach { it.invalidate() }
            }
            blur
        }

        Function("setBackdropDraw") { name: String ->
            val context = appContext.reactContext ?: throw IllegalStateException("the app context is gone")
            val draw = LookSwitch.BackdropDraw.entries.firstOrNull { it.name.equals(name, ignoreCase = true) } ?: throw IllegalArgumentException("no backdrop draw named $name")
            LookSwitch.setBackdropDraw(context, draw)
            android.util.Log.i("PAGELAB", "PAGELAB look backdrop drawn as ${draw.label}")
            LookThread.onMain { DeckBackdrops.all().forEach { it.invalidate() } }
            draw.name.lowercase()
        }

        Function("setDeckLayers") { on: Boolean ->
            val context = appContext.reactContext ?: throw IllegalStateException("the app context is gone")
            LookSwitch.setDeckLayers(context, on)
            android.util.Log.i("PAGELAB", "PAGELAB look resting deck ${if (on) "held on layers while the blobs move" else "redrawn with every blob frame"}")
            on
        }

        Function("deckLayers") {
            val context = appContext.reactContext ?: return@Function true
            LookSwitch.deckLayers(context)
        }

        Function("backdropDraw") {
            val context = appContext.reactContext ?: return@Function "small"
            LookSwitch.backdropDraw(context).name.lowercase()
        }

        Function("blurOverBackdrop") {
            val context = appContext.reactContext ?: return@Function false
            LookSwitch.blurOverBackdrop(context)
        }

        Function("blobFramesPerSecond") {
            val context = appContext.reactContext ?: return@Function 0
            LookSwitch.blobFramesPerSecond(context)
        }

        Function("lookIsOff") {
            val context = appContext.reactContext ?: return@Function false
            LookSwitch.isOff(context)
        }

        Function("probeFrosts") {
            check(PhoneLab.isOn) { "the frost probe is a lab tool" }
            appContext.currentActivity?.let(FrostProbe::probe)
            Unit
        }

        View(DeckBackdropView::class) {
            Name("DeckBackdrop")
            Prop("color") { view: DeckBackdropView, value: String? -> view.color = value }
            Prop("themeColors") { view: DeckBackdropView, value: List<String>? -> view.themeColors = value }
            Prop("darkThemeColors") { view: DeckBackdropView, value: List<String>? -> view.darkThemeColors = value }
            Prop("themeLook") { view: DeckBackdropView, value: Map<String, Any?>? -> view.themeLook = ThemeLook.from(value) }
            Prop("dark") { view: DeckBackdropView, value: Boolean? -> view.dark = value }
            Prop("reduceMotion") { view: DeckBackdropView, value: Boolean? -> view.reduceMotion = value == true }
            Prop("reduceTransparency") { view: DeckBackdropView, value: Boolean? -> view.reduceTransparency = value == true }
            OnViewDidUpdateProps { view -> view.update() }
        }

        View(ProfileBackdropView::class) {
            Name("ProfileBackdrop")
            Prop("color") { view: ProfileBackdropView, value: String? -> view.color = value }
            Prop("themeColors") { view: ProfileBackdropView, value: List<String>? -> view.themeColors = value }
            Prop("darkThemeColors") { view: ProfileBackdropView, value: List<String>? -> view.darkThemeColors = value }
            Prop("themeLook") { view: ProfileBackdropView, value: Map<String, Any?>? -> view.themeLook = ThemeLook.from(value) }
            Prop("dark") { view: ProfileBackdropView, value: Boolean? -> view.dark = value }
            Prop("themed") { view: ProfileBackdropView, value: Boolean? -> view.themed = value == true }
            Prop("softened") { view: ProfileBackdropView, value: Boolean? -> view.softened = value == true }
            Prop("fadesOut") { view: ProfileBackdropView, value: Boolean? -> view.fadesOut = value == true }
            OnViewDidUpdateProps { view -> view.update() }
        }

        View(FilmGrainView::class) {
            Name("FilmGrain")
            Prop("opacity") { view: FilmGrainView, value: Float? -> view.opacity = value ?: com.ardia.design.ProfileBackdropStyle.LIGHT_GRAIN }
            OnViewDidUpdateProps { view -> view.update() }
        }

        View(GlassBackdropView::class) {
            Name("GlassBackdrop")
        }

        View(FrostSourceView::class) {
            Name("FrostSource")
            Prop("name") { view: FrostSourceView, value: String? -> view.sourceId = value }
        }

        View(FrostView::class) {
            Name("Frost")
            Prop("source") { view: FrostView, value: String? -> view.source = value }
            Prop("name") { view: FrostView, value: String? -> view.name = value }
            Prop("variant") { view: FrostView, value: String? -> view.variant = value }
            Prop("cornerRadius") { view: FrostView, value: Float? -> view.cornerRadius = value ?: 0f }
            Prop("color") { view: FrostView, value: String? -> view.color = value }
            Prop("themeColors") { view: FrostView, value: List<String>? -> view.themeColors = value }
            Prop("darkThemeColors") { view: FrostView, value: List<String>? -> view.darkThemeColors = value }
            Prop("themeLook") { view: FrostView, value: Map<String, Any?>? -> view.themeLook = ThemeLook.from(value) }
            Prop("dark") { view: FrostView, value: Boolean? -> view.dark = value }
            Prop("reduceTransparency") { view: FrostView, value: Boolean? -> view.reduceTransparency = value == true }
            OnViewDidUpdateProps { view -> view.update() }
        }

        View(GlassView::class) {
            Name("Glass")
            Prop("source") { view: GlassView, value: String? -> view.source = value }
            Prop("name") { view: GlassView, value: String? -> view.name = value }
            Prop("cornerRadius") { view: GlassView, value: Float? -> view.glassCornerRadius = value ?: 0f }
            Prop("color") { view: GlassView, value: String? -> view.color = value }
            Prop("themeColors") { view: GlassView, value: List<String>? -> view.themeColors = value }
            Prop("darkThemeColors") { view: GlassView, value: List<String>? -> view.darkThemeColors = value }
            Prop("themeLook") { view: GlassView, value: Map<String, Any?>? -> view.themeLook = ThemeLook.from(value) }
            Prop("dark") { view: GlassView, value: Boolean? -> view.dark = value }
            Prop("reduceTransparency") { view: GlassView, value: Boolean? -> view.reduceTransparency = value == true }
            Prop("shape") { view: GlassView, value: String? -> view.shape = value }
            Prop("tint") { view: GlassView, value: android.graphics.Color? -> view.tint = value?.toArgb() }
            Prop("interactive") { view: GlassView, value: Boolean? -> view.interactive = value ?: true }
            Prop("surface") { view: GlassView, value: String? -> view.surface = value }
            Prop("tinted") { view: GlassView, value: Boolean? -> view.tinted = value == true }
            Prop("barShadow") { view: GlassView, value: Boolean? -> view.barShadow = value == true }
            Prop("classicChrome") { view: GlassView, value: Map<String, Any?>? -> view.classicFill = GlassRules.chromeFill(value) }
            Prop("shown") { view: GlassView, value: Boolean? -> view.shown = value ?: true }
            Prop("shownMs") { view: GlassView, value: Float? -> view.shownMs = (value ?: GlassRules.DEFAULT_SHOWN_MS).coerceAtLeast(0f) }
            OnViewDidUpdateProps { view -> view.update() }
        }
    }

    private fun readGlassLaunch() {
        val activity = appContext.currentActivity ?: return
        val arguments = LaunchExtras.arguments(LaunchExtras.of(activity.intent))
        GlassLaunch.flat = LiquidGlassRules.flatAsked(arguments)
    }

    companion object {
        private const val SYSTEM_LOOK_CHANGED = "onSystemLookChange"
    }
}
