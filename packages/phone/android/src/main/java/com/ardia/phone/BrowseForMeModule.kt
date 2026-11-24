package com.ardia.phone

import android.content.Context
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class BrowseForMeModule : Module() {
    private val context: Context get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "The app context is gone", null)

    private val host: BrowseForMeHost get() = BrowseForMeHost.get(context)
    private val main = Handler(Looper.getMainLooper())
    private val sink: EventSink = { event -> sendEvent("onBrowseForMe", event) }
    private var boundHost: BrowseForMeHost? = null

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneBrowseForMe")

        Events("onBrowseForMe")

        OnCreate {
            main.post {
                val react = appContext.reactContext ?: return@post
                boundHost = BrowseForMeHost.get(react).also { it.sink = sink }
            }
        }

        OnDestroy {
            main.post {
                val bound = boundHost
                if (bound != null && bound.sink === sink) {
                    bound.sink = null
                    bound.dismiss()
                }
                boundHost = null
            }
        }

        AsyncFunction("isConnected") { -> host.account.isConnected }.runOnQueue(Queues.MAIN)

        AsyncFunction("open") { query: String ->
            val activity = appContext.currentActivity ?: throw CodedException("ERR_NO_ACTIVITY", "Ardia isn't on screen", null)
            host.open(activity, query)
        }.runOnQueue(Queues.MAIN)

        AsyncFunction("account") { -> host.accountPayload() }.runOnQueue(Queues.MAIN)

        AsyncFunction("connect") Coroutine { ->
            withContext(Dispatchers.Main.immediate) {
                val activity = appContext.currentActivity ?: throw CodedException("ERR_NO_ACTIVITY", "Ardia isn't on screen", null)
                host.account.signIn(activity)
            }
        }

        AsyncFunction("disconnect") Coroutine { ->
            withContext(Dispatchers.Main.immediate) { host.account.disconnect() }
        }

        AsyncFunction("chooseModel") { slug: String -> host.account.choose(slug) }.runOnQueue(Queues.MAIN)

        AsyncFunction("chooseEffort") { effort: String? -> host.account.chooseEffort(effort?.takeIf { it.isNotEmpty() }) }.runOnQueue(Queues.MAIN)

        AsyncFunction("clearProblem") { -> host.account.clearProblem() }.runOnQueue(Queues.MAIN)

        AsyncFunction("openUsage") { -> host.openLink(ChatGPTAccount.USAGE_URL) }.runOnQueue(Queues.MAIN)
    }
}
