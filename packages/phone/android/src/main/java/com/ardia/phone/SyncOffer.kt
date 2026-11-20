package com.ardia.phone

import com.ardia.appmodel.SystemLink
import com.ardia.sync.WorkManagerSyncScheduler

object SyncOffer {
    @Volatile
    internal var forTests: Boolean? = null

    val isOffered: Boolean get() = forTests ?: PhoneLab.isOn

    class NotOffered : IllegalStateException("sync is not offered in this build")

    val backgroundWork: List<String> = listOf(WorkManagerSyncScheduler.PERIODIC_WORK, WorkManagerSyncScheduler.FLUSH_WORK)

    fun retireBackground(cancel: (String) -> Unit) {
        if (isOffered) return
        backgroundWork.forEach { runCatching { cancel(it) } }
    }

    fun retireBackground(context: android.content.Context) =
        retireBackground { androidx.work.WorkManager.getInstance(context.applicationContext ?: context).cancelUniqueWork(it) }

    fun allows(link: SystemLink): Boolean = isOffered || link != SystemLink.MacTabs
}
