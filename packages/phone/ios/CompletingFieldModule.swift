import ArdiaBrowser
import ExpoModulesCore
import UIKit

final class CompletingFieldView: ExpoView {
  let onTypedChange = EventDispatcher()
  let onSubmit = EventDispatcher()
  let onFocusChange = EventDispatcher()
  let onSuffixChange = EventDispatcher()
  let onFieldScroll = EventDispatcher()

  var textProp = ""
  var textCountProp = 0
  var offerProp: CompletionOffer?
  var autoFocus = false
  var placeholder: String?
  var placeholderColor: UIColor?
  var fontSize: CGFloat = 17
  var fontWeight: UIFont.Weight = .regular

  let field = CompletingTextField()
  let editing = CompletingFieldEditing()
  private var eventCount = 0
  private var focusedOnce = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    MainActor.assumeIsolated { setUp() }
  }

  @MainActor
  private func setUp() {
    field.clipsToBounds = true
    field.keyboardType = .webSearch
    field.returnKeyType = .go
    field.autocorrectionType = .no
    field.autocapitalizationType = .none
    field.spellCheckingType = .no
    field.smartQuotesType = .no
    field.smartDashesType = .no
    field.enablesReturnKeyAutomatically = true
    field.clearButtonMode = .never
    field.font = .systemFont(ofSize: fontSize, weight: fontWeight)
    editing.attach(field)
    editing.onTyped = { [weak self] typed in
      guard let self else { return }
      self.eventCount += 1
      self.onTypedChange(["typed": typed, "eventCount": self.eventCount])
    }
    editing.onSubmit = { [weak self] displayed in self?.onSubmit(["displayed": displayed]) }
    editing.onFocusChange = { [weak self] focused in
      guard let self else { return }
      self.field.wantsFocus = false
      self.onFocusChange(["focused": focused])
    }
    field.onSuffixChange = { [weak self] suffix in self?.onSuffixChange(["suffix": suffix]) }
    field.onTextScrolled = { [weak self] in self?.onFieldScroll([:]) }
    addSubview(field)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    field.frame = bounds
  }

  @MainActor
  func propsUpdated() {
    field.font = .systemFont(ofSize: fontSize, weight: fontWeight)
    field.attributedPlaceholder = placeholder.map { text in
      NSAttributedString(string: text, attributes: placeholderColor.map { [.foregroundColor: $0] } ?? [:])
    }
    if textCountProp >= eventCount, field.markedTextRange == nil, textProp != field.editor.typed {
      field.reset(to: textProp)
    }
    editing.offer(offerProp, to: field)
    if autoFocus, !focusedOnce {
      focusedOnce = true
      focus()
    }
  }

  @MainActor
  func focus() {
    guard field.window == nil || !field.becomeFirstResponder() else { return }
    field.wantsFocus = true
  }

  @MainActor
  func blur() {
    field.wantsFocus = false
    field.resignFirstResponder()
  }

  @MainActor
  func replace(_ text: String, selectsAll: Bool) {
    field.reset(to: text)
    if selectsAll, !text.isEmpty {
      DispatchQueue.main.async { [weak self] in self?.field.selectAllShowingStart() }
    }
  }

  static func weight(_ name: String?) -> UIFont.Weight {
    switch name {
    case "medium": .medium
    case "semibold": .semibold
    case "bold": .bold
    default: .regular
    }
  }

  static func keyboard(_ name: String?) -> UIKeyboardType {
    switch name {
    case "default": .default
    case "email-address": .emailAddress
    case "url": .URL
    case "numeric", "number-pad": .numberPad
    default: .webSearch
    }
  }

  static func returnKey(_ name: String?) -> UIReturnKeyType {
    switch name {
    case "search": .search
    case "done": .done
    case "next": .next
    case "send": .send
    default: .go
    }
  }

  static func capitalization(_ name: String?) -> UITextAutocapitalizationType {
    switch name {
    case "sentences": .sentences
    case "words": .words
    case "characters": .allCharacters
    default: .none
    }
  }
}

public final class CompletingFieldModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneCompletingField")

    View(CompletingFieldView.self) {
      Events("onTypedChange", "onSubmit", "onFocusChange", "onSuffixChange", "onFieldScroll")

      Prop("text") { (view: CompletingFieldView, text: String?) in
        view.textProp = text ?? ""
      }

      Prop("textEventCount") { (view: CompletingFieldView, count: Int?) in
        view.textCountProp = count ?? 0
      }

      Prop("offer") { (view: CompletingFieldView, offer: [String: Any]?) in
        guard let offer, let query = offer["query"] as? String else {
          view.offerProp = nil
          return
        }
        view.offerProp = CompletionOffer(query: query, completion: offer["completion"] as? String)
      }

      Prop("highlightColor") { (view: CompletingFieldView, color: UIColor?) in
        MainActor.assumeIsolated {
          let highlight = color ?? UIColor.systemBlue.withAlphaComponent(0.3)
          view.field.completionColor = highlight
          view.field.tintColor = highlight.withAlphaComponent(1)
        }
      }

      Prop("holdsScroll") { (view: CompletingFieldView, value: Bool?) in
        MainActor.assumeIsolated { view.field.holdsAppearance = value == true }
      }

      Prop("selectsAllOnFocus") { (view: CompletingFieldView, value: Bool?) in
        MainActor.assumeIsolated { view.editing.selectsAllOnFocus = value == true }
      }

      Prop("placeholder") { (view: CompletingFieldView, text: String?) in
        view.placeholder = text
      }

      Prop("placeholderTextColor") { (view: CompletingFieldView, color: UIColor?) in
        view.placeholderColor = color
      }

      Prop("color") { (view: CompletingFieldView, color: UIColor?) in
        MainActor.assumeIsolated { view.field.textColor = color ?? .label }
      }

      Prop("fontSize") { (view: CompletingFieldView, size: Double?) in
        view.fontSize = CGFloat(size ?? 17)
      }

      Prop("fontWeight") { (view: CompletingFieldView, weight: String?) in
        view.fontWeight = CompletingFieldView.weight(weight)
      }

      Prop("keyboardType") { (view: CompletingFieldView, value: String?) in
        MainActor.assumeIsolated { view.field.keyboardType = CompletingFieldView.keyboard(value) }
      }

      Prop("keyboardAppearance") { (view: CompletingFieldView, value: String?) in
        MainActor.assumeIsolated {
          view.field.keyboardAppearance = switch value {
          case "dark": .dark
          case "light": .light
          default: .default
          }
          if view.field.isFirstResponder { view.field.reloadInputViews() }
        }
      }

      Prop("returnKeyType") { (view: CompletingFieldView, value: String?) in
        MainActor.assumeIsolated { view.field.returnKeyType = CompletingFieldView.returnKey(value) }
      }

      Prop("autoCapitalize") { (view: CompletingFieldView, value: String?) in
        MainActor.assumeIsolated { view.field.autocapitalizationType = CompletingFieldView.capitalization(value) }
      }

      Prop("autoCorrect") { (view: CompletingFieldView, value: Bool?) in
        MainActor.assumeIsolated {
          view.field.autocorrectionType = value == true ? .yes : .no
          view.field.spellCheckingType = value == true ? .yes : .no
        }
      }

      Prop("autoFocus") { (view: CompletingFieldView, value: Bool?) in
        view.autoFocus = value == true
      }

      Prop("editable") { (view: CompletingFieldView, value: Bool?) in
        MainActor.assumeIsolated { view.field.isEnabled = value != false }
      }

      Prop("maxLength") { (view: CompletingFieldView, value: Int?) in
        MainActor.assumeIsolated { view.editing.maxLength = (value ?? 0) > 0 ? value : nil }
      }

      Prop("fieldLabel") { (view: CompletingFieldView, value: String?) in
        MainActor.assumeIsolated { view.field.accessibilityLabel = value }
      }

      OnViewDidUpdateProps { (view: CompletingFieldView) in
        MainActor.assumeIsolated { view.propsUpdated() }
      }

      AsyncFunction("focus") { (view: CompletingFieldView) in
        MainActor.assumeIsolated { view.focus() }
      }.runOnQueue(.main)

      AsyncFunction("blur") { (view: CompletingFieldView) in
        MainActor.assumeIsolated { view.blur() }
      }.runOnQueue(.main)

      AsyncFunction("setText") { (view: CompletingFieldView, text: String, selectsAll: Bool?) in
        MainActor.assumeIsolated { view.replace(text, selectsAll: selectsAll == true) }
      }.runOnQueue(.main)
    }
  }
}
