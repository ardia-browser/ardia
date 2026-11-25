package com.ardia.phone

import android.app.Activity
import android.view.View
import android.widget.FrameLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FirstScreenDrawnTest {
    class Root(context: android.content.Context) : FrameLayout(context)

    private fun draw(activity: Activity) {
        val observer = activity.window.decorView.viewTreeObserver
        observer.javaClass.getMethod("dispatchOnDraw").invoke(observer)
        ShadowLooper.idleMainLooper()
    }

    @Test
    fun reportsOnceWhenTheRootHasMountedViews() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = Root(activity)
        activity.setContentView(root)
        var reports = 0
        FirstScreenDrawn.watch(activity, { it is Root }) { reports++ }
        draw(activity)
        assertEquals("an empty root is not the first screen", 0, reports)
        root.addView(View(activity))
        draw(activity)
        draw(activity)
        assertEquals(1, reports)
    }

    @Test
    fun aFinishedActivityReportsNothing() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = Root(activity).apply { addView(View(activity)) }
        activity.setContentView(root)
        var reports = 0
        FirstScreenDrawn.watch(activity, { it is Root }) { reports++ }
        activity.finish()
        draw(activity)
        assertEquals(0, reports)
    }

    @Test
    fun findsTheRootUnderOtherViews() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val outer = FrameLayout(activity)
        val root = Root(activity)
        outer.addView(root)
        assertFalse(FirstScreenDrawn.hasMountedRoot(outer) { it is Root })
        root.addView(View(activity))
        assertTrue(FirstScreenDrawn.hasMountedRoot(outer) { it is Root })
    }
}
