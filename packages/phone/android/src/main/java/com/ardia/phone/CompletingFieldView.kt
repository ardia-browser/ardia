package com.ardia.phone

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.os.SystemClock
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

@SuppressLint("ViewConstructor")
class CompletingFieldView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private val onTypedChange by EventDispatcher()
    private val onSubmit by EventDispatcher()
    private val onFocusChange by EventDispatcher()
    private val onSuffixChange by EventDispatcher()

    private val input = CompletingInput()
    private var applying = false
    private var eventCount = 0
    private var pendingText: String? = null
    private var pendingTextCount = 0
    private var lastSubmit: SubmitOnce.Submit? = null
    private var submits = 0

    var highlightColor: Int = DEFAULT_HIGHLIGHT
        set(value) {
            field = value
            editor.invalidate()
        }

    private val editor = SuffixEditText(context, { input.suffix }, { highlightColor })

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        editor.apply {
            background = null
            setPadding(0, 0, 0, 0)
            isSingleLine = true
            maxLines = 1
            gravity = Gravity.CENTER_VERTICAL or Gravity.START
            imeOptions = EditorInfo.IME_ACTION_GO or EditorInfo.IME_FLAG_NO_EXTRACT_UI
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit

                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit

                override fun afterTextChanged(s: Editable) = edited()
            })
            selectionChanged = { if (!applying) edited() }
            setOnFocusChangeListener { _, focused ->
                val suffixChanged = input.focus(focused)
                onFocusChange(mapOf("focused" to focused))
                if (suffixChanged) suffixChanged()
                if (!focused) applyPendingText()
            }
            setOnEditorActionListener { _, action, event ->
                val enter = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
                if (action == EditorInfo.IME_NULL && !enter) return@setOnEditorActionListener false
                val displayed = input.displayed
                val via = if (action == EditorInfo.IME_NULL) "enter key" else "keyboard action $action"
                val now = SystemClock.uptimeMillis()
                if (SubmitOnce.isRepeat(lastSubmit, displayed, now)) {
                    if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB completion submit ignored via $via: the same press already submitted \"$displayed\"")
                    return@setOnEditorActionListener true
                }
                lastSubmit = SubmitOnce.Submit(displayed, now)
                submits += 1
                if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB completion submit #$submits \"$displayed\" via $via")
                onSubmit(mapOf("displayed" to displayed, "submit" to submits))
                true
            }
        }
        addView(editor, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    private fun edited() {
        if (applying) return
        val editable = editor.text ?: return
        val text = editable.toString()
        val applied = input.edit(
            text,
            editor.selectionStart,
            editor.selectionEnd,
            BaseInputConnection.getComposingSpanStart(editable),
            BaseInputConnection.getComposingSpanEnd(editable),
        )
        show(applied)
        if (applied.typedChanged) typedChanged()
        if (applied.suffixChanged) suffixChanged()
    }

    private fun show(applied: CompletingInput.Applied) {
        val editable = editor.text ?: return
        val textDiffers = editable.toString() != applied.text
        val selectionDiffers = editor.selectionStart != applied.selectionStart || editor.selectionEnd != applied.selectionEnd
        if (!textDiffers && !selectionDiffers) return
        applying = true
        try {
            if (textDiffers) editable.replace(0, editable.length, applied.text)
            editor.setSelection(applied.selectionStart.coerceIn(0, editor.length()), applied.selectionEnd.coerceIn(0, editor.length()))
        } finally {
            applying = false
        }
    }

    private fun typedChanged() {
        eventCount += 1
        onTypedChange(mapOf("typed" to input.typed, "eventCount" to eventCount))
    }

    private fun suffixChanged() {
        editor.invalidate()
        onSuffixChange(mapOf("suffix" to input.suffix))
    }

    var textProp: String = ""
    var textCountProp: Int = 0
    var keyboardType: String? = null
    var autoCorrect: Boolean? = null
    var autoCapitalize: String? = null
    var autoFocus: Boolean = false
    private var focusedOnce = false

    fun propsUpdated() {
        pendingText = textProp
        pendingTextCount = textCountProp
        applyPendingText()
        setKeyboard(keyboardType, autoCorrect, autoCapitalize)
        if (autoFocus && !focusedOnce) {
            focusedOnce = true
            post { focusField() }
        }
    }

    private fun applyPendingText() {
        val text = pendingText ?: return
        if (pendingTextCount < eventCount) return
        pendingText = null
        if (text == input.typed) return
        replace(text, selectsAll = false)
    }

    fun replace(text: String, selectsAll: Boolean) {
        val applied = input.reset(text, selectsAll)
        show(applied)
        if (applied.suffixChanged) suffixChanged()
    }

    fun setOffer(query: String?, completion: String?) {
        val changed = if (query == null) input.clearOffer() else input.offer(query, completion)
        if (changed) suffixChanged()
    }

    private val keyboard by lazy { FieldKeyboard(editor) }

    fun focusField() {
        editor.requestFocus()
        keyboard.open()
    }

    fun blurField() {
        editor.clearFocus()
        keyboard.close()
    }

    fun setSelectsAllOnFocus(value: Boolean) = editor.setSelectAllOnFocus(value)

    fun setPlaceholder(text: String?) {
        editor.hint = text
    }

    internal var shownCursorColor: Int? = null
        private set

    internal val shownSelectionColor: Int get() = editor.highlightColor

    fun setCursorColor(color: Int?) {
        shownCursorColor = color
        if (color == null || android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q) return
        editor.textCursorDrawable = android.graphics.drawable.GradientDrawable().apply {
            setColor(color)
            setSize((2 * resources.displayMetrics.density).toInt().coerceAtLeast(1), 0)
        }
    }

    fun setSelectionColor(color: Int?) {
        if (color != null) editor.highlightColor = color
    }

    internal val shownTextColor: Int get() = editor.currentTextColor

    internal val shownPlaceholderColor: Int get() = editor.currentHintTextColor

    fun setPlaceholderColor(color: Int?) {
        if (color != null) editor.setHintTextColor(color)
    }

    fun setTextColor(color: Int?) {
        if (color != null) editor.setTextColor(color)
    }

    fun setFontSize(size: Float?) {
        if (size != null) editor.setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
    }

    fun setFontWeight(weight: String?) {
        val value = when (weight) {
            "medium" -> 500
            "semibold" -> 600
            "bold" -> 700
            else -> 400
        }
        editor.typeface = Typeface.create(Typeface.DEFAULT, value, false)
    }

    fun setKeyboard(keyboardType: String?, autoCorrect: Boolean?, autoCapitalize: String?) {
        var type = when (keyboardType) {
            "email-address" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
            "default" -> InputType.TYPE_CLASS_TEXT
            else -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
        if (autoCorrect != true) type = type or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        type = type or when (autoCapitalize) {
            "sentences" -> InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            "words" -> InputType.TYPE_TEXT_FLAG_CAP_WORDS
            "characters" -> InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
            else -> 0
        }
        if (editor.inputType != type) editor.inputType = type
    }

    fun setReturnKey(returnKeyType: String?) {
        val action = when (returnKeyType) {
            "search" -> EditorInfo.IME_ACTION_SEARCH
            "done" -> EditorInfo.IME_ACTION_DONE
            "next" -> EditorInfo.IME_ACTION_NEXT
            "send" -> EditorInfo.IME_ACTION_SEND
            else -> EditorInfo.IME_ACTION_GO
        }
        editor.imeOptions = action or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    }

    fun setEditable(editable: Boolean) {
        editor.isEnabled = editable
    }

    fun setMaxLength(length: Int?) {
        editor.filters = if (length != null && length > 0) arrayOf(InputFilter.LengthFilter(length)) else emptyArray()
    }

    fun setLabel(label: String?) {
        editor.contentDescription = label
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height = MeasureSpec.getSize(heightMeasureSpec)
        editor.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
        setMeasuredDimension(width, height)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        editor.layout(0, 0, right - left, bottom - top)
    }

    private val layOutAgain = Runnable {
        if (width > 0 && height > 0) {
            measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
            layout(left, top, right, bottom)
        }
    }

    override fun requestLayout() {
        super.requestLayout()
        @Suppress("SENSELESS_COMPARISON")
        if (layOutAgain != null) post(layOutAgain)
    }

    companion object {
        val DEFAULT_HIGHLIGHT = android.graphics.Color.argb(77, 0, 122, 255)
    }
}

@SuppressLint("ViewConstructor", "AppCompatCustomView")
class SuffixEditText(context: Context, private val suffix: () -> String, private val highlight: () -> Int) : EditText(context) {
    var selectionChanged: (() -> Unit)? = null

    private val highlightPaint = Paint()

    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
        super.onSelectionChanged(selStart, selEnd)
        selectionChanged?.invoke()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val shown = suffix()
        val layout = layout ?: return
        if (shown.isEmpty() || layout.lineCount == 0) return
        val textPaint = paint
        val left = totalPaddingLeft + layout.getPrimaryHorizontal(length())
        val top = (totalPaddingTop + layout.getLineTop(0)).toFloat()
        val bottom = (totalPaddingTop + layout.getLineBottom(0)).toFloat()
        val baseline = (totalPaddingTop + layout.getLineBaseline(0)).toFloat()
        val width = textPaint.measureText(shown)
        canvas.save()
        canvas.clipRect(scrollX + compoundPaddingLeft, 0, scrollX + getWidth() - compoundPaddingRight, height)
        highlightPaint.color = highlight()
        canvas.drawRect(left, top, left + width, bottom, highlightPaint)
        textPaint.color = currentTextColor
        canvas.drawText(shown, left, baseline, textPaint)
        canvas.restore()
    }
}

internal object SubmitOnce {
    const val WINDOW_MILLIS = 400L

    data class Submit(val displayed: String, val at: Long)

    fun isRepeat(last: Submit?, displayed: String, now: Long): Boolean =
        last != null && last.displayed == displayed && now - last.at in 0 until WINDOW_MILLIS
}
