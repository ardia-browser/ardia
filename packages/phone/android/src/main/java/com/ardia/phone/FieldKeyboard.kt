package com.ardia.phone

import android.content.Context
import android.view.View
import android.view.ViewTreeObserver
import android.view.inputmethod.InputMethodManager
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

internal class FieldKeyboard(
    private val field: View,
    private val show: (View) -> Unit = ::requestShow,
    private val hide: (View) -> Unit = ::requestHide,
) {
    private var waiting: ViewTreeObserver.OnWindowFocusChangeListener? = null
    private var leaving: LeavingWatch? = null

    val isWaitingForWindowFocus: Boolean get() = waiting != null

    val isWatchingFocus: Boolean get() = leaving != null

    fun open() {
        watchFocusLeaving()
        if (field.hasWindowFocus()) {
            forget()
            show(field)
            return
        }
        if (waiting != null) return
        val listener = object : ViewTreeObserver.OnWindowFocusChangeListener {
            override fun onWindowFocusChanged(hasFocus: Boolean) {
                if (!hasFocus) return
                forget()
                if (field.isFocused) show(field)
            }
        }
        waiting = listener
        field.viewTreeObserver.addOnWindowFocusChangeListener(listener)
    }

    fun close() {
        forget()
        stopWatchingFocus()
        hide(field)
    }

    private fun watchFocusLeaving() {
        if (leaving != null) return
        val watch = LeavingWatch()
        leaving = watch
        field.viewTreeObserver.addOnGlobalFocusChangeListener(watch)
        field.addOnAttachStateChangeListener(watch)
    }

    private fun stopWatchingFocus() {
        val watch = leaving ?: return
        leaving = null
        field.viewTreeObserver.takeIf { it.isAlive }?.removeOnGlobalFocusChangeListener(watch)
        field.removeOnAttachStateChangeListener(watch)
    }

    private inner class LeavingWatch : ViewTreeObserver.OnGlobalFocusChangeListener, View.OnAttachStateChangeListener {
        override fun onGlobalFocusChanged(before: View?, after: View?) {
            if (before === field && after !== field) close()
        }

        override fun onViewAttachedToWindow(view: View) = Unit

        override fun onViewDetachedFromWindow(view: View) = close()
    }

    private fun forget() {
        val listener = waiting ?: return
        waiting = null
        field.viewTreeObserver.takeIf { it.isAlive }?.removeOnWindowFocusChangeListener(listener)
    }

    companion object {
        private fun inputMethods(view: View) = view.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager

        fun requestShow(view: View) {
            inputMethods(view)?.showSoftInput(view, InputMethodManager.SHOW_IMPLICIT)
        }

        fun requestHide(view: View) {
            inputMethods(view)?.hideSoftInputFromWindow(view.windowToken, 0)
            @Suppress("DEPRECATION")
            ViewCompat.getWindowInsetsController(view)?.hide(WindowInsetsCompat.Type.ime())
        }
    }
}
