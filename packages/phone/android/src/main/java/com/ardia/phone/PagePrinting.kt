package com.ardia.phone

import android.app.Activity
import android.content.Context
import android.print.PrintAttributes
import android.print.PrintManager
import com.ardia.browser.BrowserUrl
import com.ardia.browser.Page

internal object PagePrinting {
    fun jobName(title: String, address: String): String = title.trim().ifEmpty { BrowserUrl.rawHost(address) ?: address }

    fun printable(address: String?): Boolean = address != null && address.lowercase().let { it.startsWith("https://") || it.startsWith("http://") }

    fun print(activity: Activity, page: Page): Boolean {
        val state = page.state.value
        val address = state.url
        if (!printable(address)) return false
        val web = PageDrawnWatch.webViewIn(page.view.value) ?: return false
        val manager = activity.getSystemService(Context.PRINT_SERVICE) as? PrintManager ?: return false
        val name = jobName(state.title, address!!)
        return runCatching { manager.print(name, web.createPrintDocumentAdapter(name), PrintAttributes.Builder().build()) }.isSuccess
    }
}
