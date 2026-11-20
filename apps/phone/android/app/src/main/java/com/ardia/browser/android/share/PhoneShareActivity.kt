package com.ardia.browser.android.share

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.ardia.browser.android.MainActivity
import com.ardia.browser.android.system.SystemDevice
import com.ardia.browser.android.system.SystemStore
import com.ardia.design.ArdiaTheme
import com.ardia.phone.PhoneBrowsingSource
import com.ardia.phone.ShareSends
import com.ardia.phone.SyncOffer
import com.ardia.phone.UsageConsent
import java.lang.ref.WeakReference
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class ShareSession : ViewModel() {
    val key: String = UUID.randomUUID().toString()
    var shown: WeakReference<Activity>? = null
    var model: ShareSheetModel? = null
}

class PhoneShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val session = ViewModelProvider(this)[ShareSession::class.java]
        session.shown = WeakReference(this)
        val snapshot = SystemStore.shared(this).loadSnapshot()
        val app = applicationContext
        val model = session.model ?: ShareSheetModel(
            page = sharedPage(intent),
            snapshot = snapshot,
            scope = PhoneShare.scope,
            open = { link -> session.shown?.get()?.let { openInMain(it, link) } ?: false },
            send = { shared, device -> PhoneShare.send(app, session.key, shared, device) },
            finish = { session.shown?.get()?.finish() },
            cancel = { session.shown?.get()?.finish() },
            syncOffered = SyncOffer.isOffered,
        ).also { session.model = it }
        setContent {
            ArdiaTheme(darkTheme = isSystemInDarkTheme(), look = snapshot.look) {
                ShareSheetView(model)
            }
        }
    }

    companion object {
        private const val TEXT_LIMIT = 16 * 1024
        private const val SUBJECT_LIMIT = 1024

        private fun openInMain(activity: Activity, link: String): Boolean = try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link), activity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (missing: ActivityNotFoundException) {
            false
        }

        fun sharedPage(intent: Intent?): SharedPage {
            if (intent?.action != Intent.ACTION_SEND || intent.type?.startsWith("text/") != true) return SharedPage.from(null, null)
            val text = runCatching { intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() }.getOrNull()?.take(TEXT_LIMIT)
            val subject = runCatching { intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: intent.getStringExtra(Intent.EXTRA_TITLE) }.getOrNull()?.take(SUBJECT_LIMIT)
            return SharedPage.from(text, subject)
        }
    }
}

object PhoneShare {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    suspend fun send(context: Context, key: String, page: SharedPage, device: SystemDevice): Boolean {
        val url = page.url ?: return false
        if (!PhoneBrowsingSource.isSyncable(url)) return false
        val item = ShareSends.Pending(key, url, page.displayTitle, device.id, System.currentTimeMillis(), UsageConsent.window(context))
        ShareSends.record(context, item)
        val sent = ShareSends.send(context, item)
        if (!sent) ShareSends.remove(context, key)
        return sent
    }
}
