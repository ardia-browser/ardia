package com.ardia.browser.android

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import com.ardia.phone.FirstScreenDrawn
import com.ardia.phone.InsetHold
import com.ardia.phone.InsetsLab
import com.ardia.phone.JsProfiler
import com.ardia.phone.LookBudget
import com.ardia.phone.PhoneSystemLinks
import com.ardia.phone.ReactBack
import com.ardia.phone.RestorableState
import com.ardia.phone.SystemBars
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
    @Suppress("DEPRECATION")
    private val reactBack = ReactBack { onBackPressed() }

    override fun onCreate(savedInstanceState: Bundle?) {
        JsProfiler.profileStart(this)
        RestorableState.restore(savedInstanceState)
        super.onCreate(null)
        onBackPressedDispatcher.addCallback(this, reactBack)
        FirstScreenDrawn.watch(this)
        InsetsLab.watch(this)
        InsetHold.install(this)
        SystemBars.apply(window)
        PhoneSystemLinks.activityStarted(intent, restored = savedInstanceState != null)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        InsetHold.window.configurationChanged(newConfig)
        LookBudget.configurationChanged(newConfig)
        super.onConfigurationChanged(newConfig)
    }

    override fun onResume() {
        super.onResume()
        SystemBars.apply(window)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        RestorableState.save(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        PhoneSystemLinks.receive(intent)
    }

    override fun getMainComponentName(): String = "main"

    override fun createReactActivityDelegate(): ReactActivityDelegate = ReactActivityDelegateWrapper(
        this,
        BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
        object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {},
    )

    override fun invokeDefaultOnBackPressed() {
        if (ReactBack.leaveToTheBackground(this)) return
        reactBack.bypassed { super.invokeDefaultOnBackPressed() }
    }
}
