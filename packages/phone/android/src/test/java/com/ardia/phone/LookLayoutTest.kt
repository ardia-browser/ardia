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
class LookLayoutTest {
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

    private fun androidLaysOutAgain(view: View, width: Int, height: Int) {
        view.requestLayout()
        view.measure(exactly(width), exactly(height))
        view.layout(view.left, view.top, view.left + width, view.top + height)
    }

    @Test
    fun aFrostSourceKeepsTheFramesReactGaveItsChildrenWhenAndroidLaysItOutAgain() {
        val root = FrameLayout(activity)
        val source = FrostSourceView(activity, appContext)
        val backdrop = DeckBackdropView(activity, appContext)
        val caption = TextView(activity).apply { text = "caption" }
        source.addView(backdrop)
        source.addView(caption)
        root.addView(source)
        activity.setContentView(root)
        placeLikeReact(source, 0, 0, 400, 220)
        placeLikeReact(backdrop, 0, 0, 400, 220)
        placeLikeReact(caption, 10, 190, 380, 20)

        androidLaysOutAgain(source, 400, 220)

        assertEquals(listOf(0, 0, 400, 220), frame(backdrop))
        assertEquals(listOf(10, 190, 380, 20), frame(caption))
    }

    @Test
    fun aFrostKeepsItsCentredLabelWhereReactPutIt() {
        val frost = FrostView(activity, appContext)
        val label = TextView(activity).apply { text = "Frosted bar" }
        frost.addView(label)
        activity.setContentView(FrameLayout(activity).apply { addView(frost) })
        placeLikeReact(frost, 16, 300, 360, 56)
        placeLikeReact(label, 140, 18, 80, 20)

        androidLaysOutAgain(frost, 360, 56)

        assertEquals(listOf(140, 18, 80, 20), frame(label))
        assertEquals(listOf(16, 300, 360, 56), frame(frost))
    }
}
