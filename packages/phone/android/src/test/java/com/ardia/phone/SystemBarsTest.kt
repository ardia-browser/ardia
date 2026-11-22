package com.ardia.phone

import android.app.Activity
import androidx.core.view.WindowCompat
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SystemBarsTest {
    @After
    fun forget() = SystemBars.forgetForTests()

    private fun flags(activity: Activity): Pair<Boolean, Boolean> {
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        return controller.isAppearanceLightStatusBars to controller.isAppearanceLightNavigationBars
    }

    @Test
    fun lightModesDarkIconsSetTheLightNavigationBarFlagAndDarkModesLightIconsClearIt() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        SystemBars.want(SystemBars.Icons(lightStatus = false, lightNavigation = false), activity)
        val (lightStatusBar, lightNavigationBar) = flags(activity)
        assertTrue("light mode: dark status icons", lightStatusBar)
        assertTrue("light mode: dark navigation buttons on the light bar", lightNavigationBar)
        SystemBars.want(SystemBars.Icons(lightStatus = true, lightNavigation = true), activity)
        assertFalse(flags(activity).first)
        assertFalse("dark mode: light navigation buttons", flags(activity).second)
    }

    @Test
    fun aWishMadeBeforeAnyActivityIsAppliedWhenOneComes() {
        SystemBars.want(SystemBars.Icons(lightStatus = false, lightNavigation = false), null)
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.isAppearanceLightNavigationBars = false
        SystemBars.apply(activity.window)
        assertTrue("the JavaScript's first call came before the activity, and it still takes effect", flags(activity).second)
    }

    @Test
    fun aNewWindowAfterRecreationGetsTheSameIcons() {
        SystemBars.want(SystemBars.Icons(lightStatus = true, lightNavigation = false), Robolectric.buildActivity(Activity::class.java).setup().get())
        val recreated = Robolectric.buildActivity(Activity::class.java).setup().get()
        SystemBars.apply(recreated.window)
        assertFalse(flags(recreated).first)
        assertTrue(flags(recreated).second)
    }

    @Test
    fun nothingIsChangedBeforeTheJavaScriptSaysWhatItWants() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.isAppearanceLightNavigationBars = true
        SystemBars.apply(activity.window)
        assertTrue(flags(activity).second)
    }
}
