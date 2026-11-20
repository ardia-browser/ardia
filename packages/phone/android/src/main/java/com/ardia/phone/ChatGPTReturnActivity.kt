package com.ardia.phone

import android.app.Activity
import android.content.Intent
import android.os.Bundle

class ChatGPTReturnActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
            launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            runCatching { startActivity(launch) }
        }
        finish()
    }
}
