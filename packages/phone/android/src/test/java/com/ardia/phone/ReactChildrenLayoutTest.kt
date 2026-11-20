package com.ardia.phone

import android.app.Activity
import android.view.View
import android.view.View.MeasureSpec
import android.widget.FrameLayout
import android.widget.TextView
import expo.modules.kotlin.AppContext
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReactChildrenLayoutTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    private fun exactly(size: Int) = MeasureSpec.makeMeasureSpec(size, MeasureSpec.EXACTLY)

    private fun placeLikeReact(view: View, left: Int, top: Int, width: Int, height: Int) {
        view.measure(exactly(width), exactly(height))
        view.layout(left, top, left + width, top + height)
    }

    private fun frame(view: View) = listOf(view.left, view.top, view.width, view.height)

    private fun keepsItsOnlyChildWhereReactPutIt(host: View) {
        val bar = TextView(activity).apply { text = "Archive  +  Settings" }
        (host as android.view.ViewGroup).addView(bar)
        activity.setContentView(FrameLayout(activity).apply { addView(host) })
        placeLikeReact(host, 0, 0, 1080, 2400)
        placeLikeReact(bar, 0, 2133, 1080, 121)

        host.requestLayout()
        placeLikeReact(host, 0, 0, 1080, 2400)
        host.layout(0, 0, 1080, 2401)

        assertEquals("ExpoView is a LinearLayout: its own layout pass stacked the deck bar at the top", listOf(0, 2133, 1080, 121), frame(bar))
    }

    @Test
    fun theDeckChromeFadeKeepsTheBarAtTheBottomWhenAndroidLaysItOutAgain() = keepsItsOnlyChildWhereReactPutIt(MotionView(activity, appContext))
}
