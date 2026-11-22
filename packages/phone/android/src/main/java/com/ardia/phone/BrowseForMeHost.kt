package com.ardia.phone

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.view.ViewGroup
import android.view.WindowManager
import androidx.activity.ComponentDialog
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.core.view.WindowCompat
import com.ardia.design.LocalArdiaDarkTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

internal class BrowseForMeHost private constructor(context: Context) {
    private val app = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val account = ChatGPTAccount(app)
    var sink: EventSink? = null
    private var session: ResearchSession? = null
    private var dialog: ComponentDialog? = null

    init {
        account.onDisconnected = { session?.chatGPTDisconnected() }
        scope.launch {
            account.state.drop(1).collect { state ->
                send(mapOf("name" to "account", "connected" to state.isConnected, "account" to accountPayload()))
            }
        }
    }

    fun open(activity: Activity, query: String) {
        val trimmed = query.trim()
        if (trimmed.isEmpty()) return
        session?.let {
            session = null
            it.cancel()
        }
        dialog?.let {
            it.setOnDismissListener(null)
            it.dismiss()
        }
        val filter = if (PhonePages.hasEngine()) PhonePages.blocking.pageFilter(isPrivate = true) else null
        val made = ResearchSession(activity, trimmed, forcesExcerpts = false, chatGPT = account, filter = filter)
        made.onSettled = { report(it) }
        session = made
        made.start()
        dialog = present(activity, made)
    }

    private fun present(activity: Activity, made: ResearchSession): ComponentDialog {
        val shown = ComponentDialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar)
        val dark = (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val view = ComposeView(activity).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
            setContent {
                CompositionLocalProvider(LocalArdiaDarkTheme provides dark) { ResearchScreen(made, this@BrowseForMeHost) }
            }
        }
        shown.setContentView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        shown.window?.let { window ->
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
            WindowCompat.setDecorFitsSystemWindows(window, false)
            window.statusBarColor = android.graphics.Color.TRANSPARENT
            window.navigationBarColor = android.graphics.Color.TRANSPARENT
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
        shown.setOnDismissListener { closed(made) }
        shown.show()
        return shown
    }

    fun dismiss() {
        dialog?.dismiss()
    }

    fun openSource(url: String) = leave(mapOf("name" to "openSource", "url" to url))

    fun searchWeb(query: String) = leave(mapOf("name" to "searchWeb", "query" to query))

    fun openLink(url: String) = send(mapOf("name" to "openLink", "url" to url))

    private fun closed(ended: ResearchSession) {
        ended.cancel()
        if (session !== ended) return
        session = null
        dialog = null
        send(mapOf("name" to "closed"))
    }

    private fun leave(event: Map<String, Any?>) {
        session?.cancel()
        send(event)
        dismiss()
    }

    private fun report(settled: ResearchSession) {
        if (settled !== session) return
        send(mapOf("name" to "settled", "outcome" to outcome(settled), "chatGPTFellBack" to settled.chatGPTFellBack, "geminiNanoMissing" to settled.geminiNanoMissing, "rewroteAfterGeminiNanoDownload" to settled.rewroteAfterGeminiNanoDownload))
    }

    private fun outcome(settled: ResearchSession): String {
        if (settled.phase is ResearchSession.Phase.Failed) return "failed"
        return when (settled.writer) {
            is ResearchSession.Writer.ChatGPT -> "chatgpt"
            is ResearchSession.Writer.OnDevice -> "on_device"
            is ResearchSession.Writer.Excerpts -> "excerpts"
            null -> "failed"
        }
    }

    fun accountPayload(): Map<String, Any?> {
        val state = account.state.value
        val connection = state.connection
        val model = connection?.model
        return mapOf(
            "connected" to state.isConnected,
            "label" to state.accountLabel,
            "signingIn" to state.isSigningIn,
            "problem" to state.problem,
            "model" to model?.slug,
            "effort" to connection?.effort,
            "models" to connection?.models.orEmpty().map { mapOf("slug" to it.slug, "name" to it.displayName, "efforts" to it.efforts, "defaultEffort" to it.defaultEffort) },
        )
    }

    private fun send(event: Map<String, Any?>) {
        sink?.invoke(event)
    }

    companion object {
        @Volatile private var shared: BrowseForMeHost? = null

        fun get(context: Context): BrowseForMeHost = shared ?: synchronized(this) { shared ?: BrowseForMeHost(context).also { shared = it } }
    }
}
