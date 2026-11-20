package com.ardia.browser.android

import android.app.Application
import android.content.res.Configuration
import com.ardia.phone.PhoneLab
import com.ardia.phone.PhoneSync
import com.ardia.phone.SyncOffer
import com.ardia.phone.UpgradeGate
import com.ardia.sync.SyncController
import com.ardia.sync.SyncControllerOwner
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

class MainApplication : Application(), ReactApplication, SyncControllerOwner {
    override val syncController: SyncController
        get() = PhoneSync.controller(this)

    override val isSyncReady: Boolean
        get() = SyncOffer.isOffered && !UpgradeGate.pending(this)

    override val reactHost: ReactHost by lazy {
        ExpoReactHostFactory.getDefaultReactHost(context = applicationContext, packageList = PackageList(this).packages)
    }

    override fun onCreate() {
        super.onCreate()
        DefaultNewArchitectureEntryPoint.releaseLevel = runCatching {
            ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
        }.getOrDefault(ReleaseLevel.STABLE)
        if (PhoneLab.isOn) {
            android.util.Log.i("PAGELAB", "PAGELAB build ${getString(R.string.ardia_build_commit)} dirty: ${getString(R.string.ardia_build_dirty)} from the ${getString(R.string.ardia_build_source)}; native ${getString(R.string.ardia_build_native)}")
        }
        UpgradeGate.install(this)
        SyncOffer.retireBackground(this)
        LabNetworkLog.install(this)
        loadReactNative(this)
        ApplicationLifecycleDispatcher.onApplicationCreate(this)
        SystemExport.start(this)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
        SystemExport.configurationChanged(this, newConfig.uiMode)
    }
}
