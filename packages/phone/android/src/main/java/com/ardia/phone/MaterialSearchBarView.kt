package com.ardia.phone

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.os.SystemClock
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.FilledIconToggleButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.IconToggleButtonColors
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.PlatformTextInputMethodRequest
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.ardia.design.ArdiaSymbols
import com.ardia.search.CompletingFieldState
import com.ardia.store.CompletionOffer
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

@SuppressLint("ViewConstructor")
class MaterialSearchBarView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private val onTypedChange by EventDispatcher()
    private val onSubmit by EventDispatcher()
    private val onFocusChange by EventDispatcher()
    private val onSuffixChange by EventDispatcher()
    private val onClearPress by EventDispatcher()
    private val onVoicePress by EventDispatcher()
    private val onIncognitoPress by EventDispatcher()

    private val state = CompletingFieldState()
    private val focusRequester = FocusRequester()
    private var eventCount by mutableIntStateOf(0)
    private var focusRequests by mutableIntStateOf(0)
    private var focusWanted = false
    private var pendingText: String? = null
    private var pendingTextCount = 0
    private var selectsAllOnFocus = false
    private var lastSubmit: SubmitOnce.Submit? = null
    private var submits = 0

    var textProp: String = ""
    var textCountProp: Int = 0
    var offerQuery: String? = null
    var offerCompletion: String? = null
    var dark: Boolean? = null
    var scheme: Map<String, String>? = null

    private var colors by mutableStateOf(currentColors())
    private var placeholderText by mutableStateOf("Search\u2026")
    private var fieldLabelText by mutableStateOf("Search or Enter Address")
    private var incognitoState by mutableStateOf(false)
    private var showsVoiceState by mutableStateOf(false)
    private var fieldOnlyState by mutableStateOf(false)
    var embedded by mutableStateOf(false)

    private val compose = ComposeView(context).apply {
        setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
        setContent {
            MaterialSearchBarContent(
                scheme = colors,
                state = state,
                focusRequester = focusRequester,
                focusRequests = focusRequests,
                focusWanted = { focusWanted },
                placeholder = placeholderText,
                fieldLabel = fieldLabelText,
                incognito = incognitoState,
                showsVoice = showsVoiceState,
                fieldOnly = fieldOnlyState,
                embedded = embedded,
                onValueChange = ::edited,
                onFocusChanged = ::focused,
                onSubmit = ::submitNow,
                onClear = ::clearNow,
                onVoice = { onVoicePress(emptyMap()) },
                onIncognito = { onIncognitoPress(emptyMap()) },
            )
        }
    }

    init {
        clipChildren = false
        clipToPadding = false
        addView(compose, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    fun setPlaceholder(value: String?) {
        placeholderText = value?.takeIf { it.isNotEmpty() } ?: "Search\u2026"
    }

    fun setLabel(value: String?) {
        fieldLabelText = value?.takeIf { it.isNotEmpty() } ?: "Search or Enter Address"
    }

    fun setSelectsAllOnFocus(value: Boolean) {
        selectsAllOnFocus = value
    }

    fun setIncognito(value: Boolean) {
        if (incognitoState == value) return
        incognitoState = value
        if (state.isFocused) compose.postOnAnimation { compose.post { restartKeyboard() } }
    }

    private fun restartKeyboard() {
        if (!isAttachedToWindow || !state.isFocused) return
        val target = compose.findFocus() ?: return
        context.getSystemService(InputMethodManager::class.java)?.restartInput(target)
    }

    fun setShowsVoice(value: Boolean) {
        showsVoiceState = value
    }

    fun setFieldOnly(value: Boolean) {
        fieldOnlyState = value
    }

    fun setOffer(query: String?, completion: String?) {
        offerQuery = query
        offerCompletion = completion
        applyOffer()
    }

    fun propsUpdated() {
        pendingText = textProp
        pendingTextCount = textCountProp
        applyPendingText()
        applyOffer()
        refreshColors()
    }

    fun refreshColors() {
        colors = currentColors()
    }

    private fun currentColors(): ColorScheme {
        val fresh = appContext.currentActivity ?: context
        return MaterialScheme.colorScheme(fresh, dark ?: ((fresh.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES), scheme)
    }

    override fun onConfigurationChanged(newConfig: Configuration?) {
        super.onConfigurationChanged(newConfig)
        post { refreshColors() }
    }

    private fun applyPendingText() {
        val text = pendingText ?: return
        if (pendingTextCount < eventCount) return
        pendingText = null
        if (text == state.typed) return
        replace(text, selectsAllOnFocus && !state.isFocused && text.isNotEmpty())
    }

    private fun applyOffer() {
        val before = state.suffix
        val query = offerQuery
        state.offer(if (query != null) CompletionOffer(query, offerCompletion) else null)
        if (state.suffix != before) onSuffixChange(mapOf("suffix" to state.suffix))
    }

    private fun edited(next: TextFieldValue) {
        val beforeSuffix = state.suffix
        val typedChanged = state.edit(next)
        if (typedChanged) {
            eventCount += 1
            onTypedChange(mapOf("typed" to state.typed, "eventCount" to eventCount))
        }
        if (state.suffix != beforeSuffix) onSuffixChange(mapOf("suffix" to state.suffix))
    }

    private fun focused(isFocused: Boolean) {
        val wasFocused = state.isFocused
        if (isFocused == wasFocused) return
        val beforeSuffix = state.suffix
        state.focusChanged(isFocused)
        if (isFocused && selectsAllOnFocus && state.typed.isNotEmpty()) {
            state.reset(state.typed, selectsAll = true)
        }
        onFocusChange(mapOf("focused" to isFocused))
        if (state.suffix != beforeSuffix) onSuffixChange(mapOf("suffix" to state.suffix))
        if (!isFocused) {
            focusWanted = false
            applyPendingText()
        } else applyOffer()
    }

    private fun submitNow() {
        val displayed = state.display
        val now = SystemClock.uptimeMillis()
        if (SubmitOnce.isRepeat(lastSubmit, displayed, now)) return
        lastSubmit = SubmitOnce.Submit(displayed, now)
        submits += 1
        onSubmit(mapOf("displayed" to displayed, "submit" to submits))
    }

    private fun clearNow() {
        val hadText = state.typed.isNotEmpty()
        val hadSuffix = state.suffix.isNotEmpty()
        state.reset("", selectsAll = false)
        if (hadText) {
            eventCount += 1
            onTypedChange(mapOf("typed" to "", "eventCount" to eventCount))
        }
        if (hadSuffix) onSuffixChange(mapOf("suffix" to ""))
        onClearPress(emptyMap())
    }

    fun replace(text: String, selectsAll: Boolean) {
        val beforeTyped = state.typed
        val beforeSuffix = state.suffix
        state.reset(text, selectsAll)
        if (state.typed != beforeTyped) {
            eventCount += 1
            onTypedChange(mapOf("typed" to state.typed, "eventCount" to eventCount))
        }
        if (state.suffix != beforeSuffix) onSuffixChange(mapOf("suffix" to state.suffix))
    }

    fun focusField() {
        focusWanted = true
        focusRequests += 1
        post {
            if (!isAttachedToWindow || !focusWanted) return@post
            runCatching { focusRequester.requestFocus() }
            if (selectsAllOnFocus && state.typed.isNotEmpty()) state.reset(state.typed, selectsAll = true)
            val target = compose.findFocus() ?: compose.getChildAt(0) ?: compose
            context.getSystemService(InputMethodManager::class.java)?.showSoftInput(target, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    fun blurField() {
        focusWanted = false
        val beforeSuffix = state.suffix
        state.dropSuffix()
        if (state.suffix != beforeSuffix) onSuffixChange(mapOf("suffix" to state.suffix))
        compose.clearFocus()
        context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(windowToken, 0)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height = MeasureSpec.getSize(heightMeasureSpec)
        compose.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
        setMeasuredDimension(width, height)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        compose.layout(0, 0, right - left, bottom - top)
    }
}

internal object CompletionSuffixTransformation {
    fun of(suffix: String, highlight: Color, ink: Color): VisualTransformation {
        if (suffix.isEmpty()) return VisualTransformation.None
        return VisualTransformation { text ->
            val combined = AnnotatedString.Builder(text).apply {
                pushStyle(SpanStyle(color = ink, background = highlight))
                append(suffix)
                pop()
            }.toAnnotatedString()
            val typedLength = text.length
            val totalLength = combined.length
            TransformedText(
                combined,
                object : OffsetMapping {
                    override fun originalToTransformed(offset: Int): Int = offset.coerceIn(0, typedLength)

                    override fun transformedToOriginal(offset: Int): Int = offset.coerceIn(0, totalLength).coerceAtMost(typedLength)
                },
            )
        }
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun NoPersonalizedLearning(enabled: Boolean, content: @Composable () -> Unit) {
    val noLearning by rememberUpdatedState(enabled)
    InterceptPlatformTextInput(
        interceptor = { request, next ->
            next.startInputMethod(object : PlatformTextInputMethodRequest {
                override fun createInputConnection(outAttributes: EditorInfo): InputConnection {
                    val connection = request.createInputConnection(outAttributes)
                    if (noLearning) outAttributes.imeOptions = outAttributes.imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
                    return connection
                }
            })
        },
        content = content,
    )
}

@Composable
private fun MaterialSearchBarContent(
    scheme: ColorScheme,
    state: CompletingFieldState,
    focusRequester: FocusRequester,
    focusRequests: Int,
    focusWanted: () -> Boolean,
    placeholder: String,
    fieldLabel: String,
    incognito: Boolean,
    showsVoice: Boolean,
    fieldOnly: Boolean,
    embedded: Boolean,
    onValueChange: (TextFieldValue) -> Unit,
    onFocusChanged: (Boolean) -> Unit,
    onSubmit: () -> Unit,
    onClear: () -> Unit,
    onVoice: () -> Unit,
    onIncognito: () -> Unit,
) {
    val keyboardController = LocalSoftwareKeyboardController.current
    LaunchedEffect(focusRequests) {
        if (focusRequests > 0 && focusWanted()) {
            runCatching { focusRequester.requestFocus() }
            keyboardController?.show()
        }
    }
    MaterialTheme(colorScheme = scheme) {
        val fieldContainer = if (embedded) Color.Transparent else scheme.surfaceContainerHigh
        val ink = scheme.onSurface
        val inkVariant = scheme.onSurfaceVariant
        val accent = scheme.primary
        val highlight = accent.copy(alpha = 0.3f)
        val selectionColors = TextSelectionColors(handleColor = accent, backgroundColor = highlight)
        Surface(
            modifier = Modifier.fillMaxSize(),
            shape = CircleShape,
            color = fieldContainer,
            contentColor = ink,
        ) {
            Row(
                modifier = Modifier.fillMaxSize().padding(start = 12.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (!fieldOnly) Icon(
                    imageVector = ArdiaSymbols.magnifyingglass,
                    contentDescription = null,
                    tint = inkVariant,
                    modifier = Modifier.size(24.dp),
                )
                CompositionLocalProvider(LocalTextSelectionColors provides selectionColors) { NoPersonalizedLearning(incognito) {
                    BasicTextField(
                        value = state.value,
                        onValueChange = onValueChange,
                        modifier = Modifier
                            .weight(1f)
                            .focusRequester(focusRequester)
                            .onFocusChanged { onFocusChanged(it.isFocused) }
                            .semantics { contentDescription = fieldLabel },
                        singleLine = true,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = ink),
                        cursorBrush = SolidColor(accent),
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            keyboardType = if (fieldOnly) KeyboardType.Text else KeyboardType.Uri,
                            imeAction = if (fieldOnly) ImeAction.Search else ImeAction.Go,
                        ),
                        keyboardActions = KeyboardActions(onGo = { onSubmit() }, onSearch = { onSubmit() }, onDone = { onSubmit() }),
                        visualTransformation = CompletionSuffixTransformation.of(state.suffix, highlight, ink),
                        decorationBox = { innerTextField ->
                            Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
                                if (state.value.text.isEmpty() && state.suffix.isEmpty()) {
                                    Text(text = placeholder, style = MaterialTheme.typography.bodyLarge, color = inkVariant, maxLines = 1)
                                }
                                innerTextField()
                            }
                        },
                    )
                } }
                val showsClear = state.value.text.isNotEmpty()
                val showsVoiceButton = !showsClear && !incognito && showsVoice
                val showsIncognito = !fieldOnly
                if (showsClear || showsVoiceButton || showsIncognito) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (showsClear) {
                            IconButton(
                                onClick = onClear,
                                modifier = Modifier.size(40.dp),
                                colors = IconButtonDefaults.iconButtonColors(contentColor = inkVariant),
                            ) {
                                Icon(imageVector = ArdiaSymbols.xmark, contentDescription = "Clear Text", modifier = Modifier.size(20.dp))
                            }
                        } else if (showsVoiceButton) {
                            IconButton(
                                onClick = onVoice,
                                modifier = Modifier.size(40.dp),
                                colors = IconButtonDefaults.iconButtonColors(contentColor = inkVariant),
                            ) {
                                Icon(imageVector = ArdiaSymbols.mic, contentDescription = "Voice Search", modifier = Modifier.size(20.dp))
                            }
                        }
                        if (showsIncognito) FilledIconToggleButton(
                            checked = incognito,
                            onCheckedChange = { onIncognito() },
                            modifier = Modifier.size(40.dp),
                            colors = IconToggleButtonColors(
                                containerColor = Color.Transparent,
                                contentColor = inkVariant,
                                disabledContainerColor = Color.Transparent,
                                disabledContentColor = inkVariant,
                                checkedContainerColor = scheme.primaryContainer,
                                checkedContentColor = scheme.onPrimaryContainer,
                            ),
                        ) {
                            Icon(
                                imageVector = ArdiaSymbols.eyeglasses,
                                contentDescription = if (incognito) "Deactivate Incognito" else "Activate Incognito",
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}
