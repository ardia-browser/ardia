package com.ardia.phone

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CompletingFieldModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneCompletingField")

        View(CompletingFieldView::class) {
            Events("onTypedChange", "onSubmit", "onFocusChange", "onSuffixChange")

            Prop("text") { view: CompletingFieldView, text: String? -> view.textProp = text ?: "" }
            Prop("textEventCount") { view: CompletingFieldView, count: Int? -> view.textCountProp = count ?: 0 }
            Prop("offer") { view: CompletingFieldView, offer: Map<String, Any?>? ->
                view.setOffer(offer?.get("query") as? String, offer?.get("completion") as? String)
            }
            Prop("highlightColor") { view: CompletingFieldView, color: Int? -> view.highlightColor = color ?: CompletingFieldView.DEFAULT_HIGHLIGHT }
            Prop("selectsAllOnFocus") { view: CompletingFieldView, value: Boolean? -> view.setSelectsAllOnFocus(value == true) }
            Prop("placeholder") { view: CompletingFieldView, text: String? -> view.setPlaceholder(text) }
            Prop("placeholderTextColor") { view: CompletingFieldView, color: Int? -> view.setPlaceholderColor(color) }
            Prop("color") { view: CompletingFieldView, color: Int? -> view.setTextColor(color) }
            Prop("cursorColor") { view: CompletingFieldView, color: Int? -> view.setCursorColor(color) }
            Prop("selectionColor") { view: CompletingFieldView, color: Int? -> view.setSelectionColor(color) }
            Prop("fontSize") { view: CompletingFieldView, size: Float? -> view.setFontSize(size) }
            Prop("fontWeight") { view: CompletingFieldView, weight: String? -> view.setFontWeight(weight) }
            Prop("keyboardType") { view: CompletingFieldView, value: String? -> view.keyboardType = value }
            Prop("autoCorrect") { view: CompletingFieldView, value: Boolean? -> view.autoCorrect = value }
            Prop("autoCapitalize") { view: CompletingFieldView, value: String? -> view.autoCapitalize = value }
            Prop("returnKeyType") { view: CompletingFieldView, value: String? -> view.setReturnKey(value) }
            Prop("editable") { view: CompletingFieldView, value: Boolean? -> view.setEditable(value != false) }
            Prop("maxLength") { view: CompletingFieldView, value: Int? -> view.setMaxLength(value) }
            Prop("autoFocus") { view: CompletingFieldView, value: Boolean? -> view.autoFocus = value == true }
            Prop("fieldLabel") { view: CompletingFieldView, value: String? -> view.setLabel(value) }
            Prop("revealFocus") { view: CompletingFieldView, generation: Int? -> view.revealFocusProp = generation ?: 0 }

            OnViewDidUpdateProps { view -> view.propsUpdated() }

            AsyncFunction("focus") { view: CompletingFieldView -> view.focusField() }.runOnQueue(Queues.MAIN)

            AsyncFunction("blur") { view: CompletingFieldView -> view.blurField() }.runOnQueue(Queues.MAIN)

            AsyncFunction("setText") { view: CompletingFieldView, text: String, selectsAll: Boolean? -> view.replace(text, selectsAll == true) }.runOnQueue(Queues.MAIN)
        }
    }
}
