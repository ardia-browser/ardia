package com.ardia.phone

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import com.ardia.search.CompletingFieldState
import com.ardia.store.CompletionOffer

class CompletingInput(initial: String = "") {
    data class Applied(val text: String, val selectionStart: Int, val selectionEnd: Int, val typedChanged: Boolean, val suffixChanged: Boolean)

    private val state = CompletingFieldState(initial)

    val typed: String get() = state.typed

    val suffix: String get() = state.suffix

    val displayed: String get() = state.display

    val isFocused: Boolean get() = state.isFocused

    fun edit(text: String, selectionStart: Int, selectionEnd: Int, composingStart: Int, composingEnd: Int): Applied {
        val suffixBefore = state.suffix
        val start = selectionStart.coerceIn(0, text.length)
        val end = selectionEnd.coerceIn(0, text.length)
        val composition = if (composingStart in 0..text.length && composingEnd in 0..text.length && composingStart != composingEnd) TextRange(composingStart, composingEnd) else null
        val typedChanged = state.edit(TextFieldValue(text, TextRange(start, end), composition))
        return applied(typedChanged, state.suffix != suffixBefore)
    }

    fun offer(query: String, completion: String?): Boolean = changesSuffix { state.offer(CompletionOffer(query, completion)) }

    fun clearOffer(): Boolean = changesSuffix { state.offer(null) }

    fun focus(focused: Boolean): Boolean = changesSuffix { state.focusChanged(focused) }

    fun dropSuffix(): Boolean = changesSuffix { state.dropSuffix() }

    fun reset(text: String, selectsAll: Boolean = false): Applied {
        val suffixBefore = state.suffix
        val typedBefore = state.typed
        state.reset(text, selectsAll)
        return applied(state.typed != typedBefore, state.suffix != suffixBefore)
    }

    private fun changesSuffix(change: () -> Unit): Boolean {
        val before = state.suffix
        change()
        return state.suffix != before
    }

    private fun applied(typedChanged: Boolean, suffixChanged: Boolean): Applied {
        val value = state.value
        return Applied(value.text, value.selection.start, value.selection.end, typedChanged, suffixChanged)
    }
}
