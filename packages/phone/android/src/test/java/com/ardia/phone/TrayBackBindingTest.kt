package com.ardia.phone

import androidx.activity.OnBackPressedCallback
import androidx.activity.OnBackPressedDispatcher
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TrayBackBindingTest {
    private class Host : LifecycleOwner {
        private val registry = LifecycleRegistry.createUnsafe(this).apply { currentState = Lifecycle.State.RESUMED }
        override val lifecycle: Lifecycle get() = registry
        var reactHeard = 0
        val dispatcher = OnBackPressedDispatcher().also { dispatcher ->
            dispatcher.addCallback(object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    reactHeard += 1
                }
            })
        }
    }

    private val heard = ArrayList<String>()
    private val binding = TrayBackBinding { name, _ -> heard += name }

    @Test
    fun aRecreatedActivityGetsTheTrayBackAgainWhileTheTrayIsUp() {
        val first = Host()
        binding.want(true, first.dispatcher, first)
        binding.lost()
        val second = Host()
        binding.bind(second.dispatcher, second)
        second.dispatcher.onBackPressed()
        assertEquals(listOf(TrayBack.CANCEL, TrayBack.COMMIT), heard)
        assertEquals(0, second.reactHeard)
        first.dispatcher.onBackPressed()
        assertEquals("the destroyed activity's dispatcher no longer reaches the tray", 1, first.reactHeard)
    }

    @Test
    fun aTornDownModuleLeavesNoCallbackThatSwallowsBack() {
        val host = Host()
        binding.want(true, host.dispatcher, host)
        binding.release()
        host.dispatcher.onBackPressed()
        assertEquals(emptyList<String>(), heard)
        assertEquals(1, host.reactHeard)
    }

    @Test
    fun disablingWorksWithNoActivityAtHand() {
        val host = Host()
        binding.want(true, host.dispatcher, host)
        binding.want(false, null, null)
        host.dispatcher.onBackPressed()
        assertEquals(1, host.reactHeard)
    }
}
