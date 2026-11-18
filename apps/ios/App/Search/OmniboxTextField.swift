import ArdiaBrowser
import ArdiaDesign
import SwiftUI
import UIKit

struct OmniboxTextField: UIViewRepresentable {
  @Binding var text: String
  @Binding var isFocused: Bool
  var completion: CompletionOffer?
  var placeholder: String
  var isIncognito: Bool
  var selectsAllOnFocus: Bool
  var reveal: TrayReveal
  var onSubmit: (String) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(parent: self)
  }

  func makeUIView(context: Context) -> CompletingTextField {
    let field = CompletingTextField()
    field.clipsToBounds = true
    field.delegate = context.coordinator
    field.keyboardType = .webSearch
    field.returnKeyType = .go
    field.autocorrectionType = .no
    field.autocapitalizationType = .none
    field.spellCheckingType = .no
    field.smartQuotesType = .no
    field.smartDashesType = .no
    field.enablesReturnKeyAutomatically = true
    field.clearButtonMode = .never
    field.adjustsFontForContentSizeCategory = true
    field.font = UIFontMetrics(forTextStyle: .title3).scaledFont(for: .systemFont(ofSize: 20))
    field.setContentHuggingPriority(.defaultLow, for: .horizontal)
    field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    field.addTarget(context.coordinator, action: #selector(Coordinator.editingChanged(_:)), for: .editingChanged)
    field.accessibilityLabel = String(localized: "Search or Enter Address")
    field.text = text
    field.alpha = reveal.revealsContents ? 1 : 0
    context.coordinator.isRevealed = reveal.revealsContents
    apply(to: field)
    return field
  }

  private func applyReveal(to field: UIView, coordinator: Coordinator) {
    guard coordinator.isRevealed != reveal.revealsContents else { return }
    coordinator.isRevealed = reveal.revealsContents
    guard reveal.revealsContents else {
      field.alpha = 0
      return
    }
    let base = CACurrentMediaTime()
    field.restartOpacityFade(to: 1, after: Motion.trayRevealFieldDelay, from: base, curve: Motion.trayRevealCurve)
    reveal.onReveal(base)
  }

  func updateUIView(_ field: CompletingTextField, context: Context) {
    let coordinator = context.coordinator
    coordinator.parent = self
    applyReveal(to: field, coordinator: coordinator)
    apply(to: field)
    if field.markedTextRange == nil, coordinator.echo.isExternal(text, current: field.editor.typed) {
      field.reset(to: text)
    }
    coordinator.offer(completion, to: field)
    field.wantsFocus = isFocused
    if isFocused, !field.isFirstResponder, field.window != nil {
      field.becomeFirstResponderNextTurn(ifStillWanted: { self.isFocused })
    } else if !isFocused, field.isFirstResponder {
      if reveal.isLeaving { field.freezeAppearance() }
      DispatchQueue.main.async {
        guard !self.isFocused, field.isFirstResponder else { return }
        field.resignFirstResponder()
      }
    }
  }

  private func apply(to field: CompletingTextField) {
    let placeholderStyle = PlaceholderStyle(text: isFocused ? placeholder : "", isIncognito: isIncognito)
    if field.placeholderStyle != placeholderStyle {
      field.placeholderStyle = placeholderStyle
      let placeholderColor = isIncognito ? UIColor.incognitoPlaceholder : UIColor(BrowsePalette.foregroundTertiary)
      field.attributedPlaceholder = placeholderStyle.text.isEmpty
        ? nil
        : NSAttributedString(string: placeholderStyle.text, attributes: [.foregroundColor: placeholderColor])
    }
    field.textColor = isIncognito ? .white : UIColor(BrowsePalette.foregroundPrimary)
    field.tintColor = UIColor(BrowsePalette.searchAccent)
    field.keyboardAppearance = isIncognito ? .dark : .default
  }

  @MainActor
  final class Coordinator: NSObject, UITextFieldDelegate {
    var parent: OmniboxTextField
    var echo = BindingEchoFilter()
    var isRevealed = true
    private var didSelectAllOnFocus = false

    init(parent: OmniboxTextField) {
      self.parent = parent
    }

    private func push(_ field: CompletingTextField) {
      let value = field.editor.typed
      echo.pushed(value)
      parent.text = value
    }

    @objc func editingChanged(_ field: CompletingTextField) {
      guard field.markedTextRange == nil, !field.isApplyingCompletion else { return }
      field.editor.syncTyped(field.text ?? "")
      push(field)
    }

    func offer(_ offer: CompletionOffer?, to field: CompletingTextField) {
      guard field.canShowCompletion else {
        if field.editor.hasSuffix, field.markedTextRange == nil, !field.isFirstResponder || field.usesComposingInput {
          field.editor.dropSuffix()
          field.render()
        }
        return
      }
      if field.editor.receive(offer) { field.render() }
    }

    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
      guard let field = textField as? CompletingTextField, !field.isApplyingCompletion else { return true }
      guard field.markedTextRange == nil, !field.usesComposingInput else { return true }
      if string.isEmpty {
        guard field.editor.deleteBackward() == .consumed else { return true }
        field.render()
        push(field)
        return false
      }
      guard field.editor.hasSuffix, range.location == field.typedLength else {
        if field.editor.hasSuffix {
          field.editor.accept()
          field.showAccepted()
          push(field)
        }
        _ = field.editor.insert(string)
        return true
      }
      switch field.editor.insert(string) {
      case .consumed:
        field.render()
        push(field)
      case .insertTyped:
        field.render()
        field.insertText(string)
      }
      return false
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
      guard let field = textField as? CompletingTextField else { return true }
      let submitted = field.editor.display
      guard SearchInput.submission(from: submitted) != nil else { return false }
      parent.onSubmit(submitted)
      return false
    }

    func textFieldDidBeginEditing(_ textField: UITextField) {
      if !parent.isFocused { parent.isFocused = true }
      if parent.selectsAllOnFocus, !didSelectAllOnFocus, !(textField.text ?? "").isEmpty {
        didSelectAllOnFocus = true
        DispatchQueue.main.async { (textField as? CompletingTextField)?.selectAllShowingStart() ?? textField.selectAll(nil) }
      }
    }

    func textFieldDidChangeSelection(_ textField: UITextField) {
      guard let field = textField as? CompletingTextField, field.editor.hasSuffix, !field.isApplyingCompletion, !field.isCaretAtTypedEnd else { return }
      field.editor.accept()
      field.showAccepted()
      push(field)
    }

    func textFieldDidEndEditing(_ textField: UITextField) {
      if let field = textField as? CompletingTextField, field.editor.hasSuffix {
        field.editor.dropSuffix()
        field.render()
      }
      if parent.isFocused { parent.isFocused = false }
    }
  }
}

struct PlaceholderStyle: Equatable {
  let text: String
  let isIncognito: Bool
}

final class CompletingTextField: UITextField {
  var editor = InlineCompletionEditor()
  var placeholderStyle: PlaceholderStyle?
  private let completionColor = UIColor(BrowsePalette.searchAccent).withAlphaComponent(0.3)
  private(set) var isApplyingCompletion = false
  var wantsFocus = false
  var typedLength: Int { (editor.typed as NSString).length }
  static let horizontalInset: CGFloat = 3
  private static let composingLanguages = ["ja", "zh", "ko"]

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard wantsFocus, window != nil else { return }
    becomeFirstResponderNextTurn(ifStillWanted: { [weak self] in self?.wantsFocus == true && self?.window != nil })
  }

  func becomeFirstResponderNextTurn(ifStillWanted isWanted: @escaping () -> Bool) {
    DispatchQueue.main.async { [weak self] in
      guard let self, isWanted(), !self.isFirstResponder else { return }
      self.becomeFirstResponder()
    }
  }

  func selectAllShowingStart() {
    selectedTextRange = textRange(from: beginningOfDocument, to: endOfDocument)
    UIView.performWithoutAnimation {
      layoutIfNeeded()
      for scroller in Self.scrollers(in: self) { scroller.setContentOffset(.zero, animated: false) }
    }
  }

  func freezeAppearance() {
    guard let still = snapshotView(afterScreenUpdates: false) else { return }
    still.frame = bounds
    still.isUserInteractionEnabled = false
    addSubview(still)
  }

  private static func scrollers(in view: UIView) -> [UIScrollView] {
    view.subviews.flatMap { child -> [UIScrollView] in
      let nested = scrollers(in: child)
      guard let scroller = child as? UIScrollView else { return nested }
      return [scroller] + nested
    }
  }

  override func textRect(forBounds bounds: CGRect) -> CGRect {
    super.textRect(forBounds: bounds).insetBy(dx: Self.horizontalInset, dy: 0)
  }

  override func editingRect(forBounds bounds: CGRect) -> CGRect {
    super.editingRect(forBounds: bounds).insetBy(dx: Self.horizontalInset, dy: 0)
  }

  override func placeholderRect(forBounds bounds: CGRect) -> CGRect {
    super.placeholderRect(forBounds: bounds).insetBy(dx: Self.horizontalInset, dy: 0)
  }

  var usesComposingInput: Bool {
    guard let language = textInputMode?.primaryLanguage else { return false }
    return Self.composingLanguages.contains { language.hasPrefix($0) }
  }

  var canShowCompletion: Bool {
    isFirstResponder && markedTextRange == nil && !usesComposingInput && (editor.hasSuffix || isCaretAtTypedEnd)
  }

  var isCaretAtTypedEnd: Bool {
    guard let selection = selectedTextRange, selection.isEmpty else { return false }
    return offset(from: beginningOfDocument, to: selection.start) == typedLength
  }

  func reset(to value: String) {
    editor.reset(to: value)
    isApplyingCompletion = true
    defer { isApplyingCompletion = false }
    text = value
  }

  func render() {
    isApplyingCompletion = true
    defer { isApplyingCompletion = false }
    if editor.hasSuffix {
      var attributes = defaultTextAttributes
      let attributed = NSMutableAttributedString(string: editor.typed, attributes: attributes)
      attributes[.backgroundColor] = completionColor
      attributed.append(NSAttributedString(string: editor.suffix, attributes: attributes))
      attributedText = attributed
    } else if text != editor.typed || attributedText?.length != typedLength || hasCompletionStyling {
      text = editor.typed
    }
    if let caret = position(from: beginningOfDocument, offset: typedLength) {
      selectedTextRange = textRange(from: caret, to: caret)
    }
  }

  func showAccepted() {
    isApplyingCompletion = true
    defer { isApplyingCompletion = false }
    let selection = selectedTextRange
    text = editor.typed
    if let selection { selectedTextRange = selection }
  }

  private var hasCompletionStyling: Bool {
    guard let attributedText, attributedText.length > 0 else { return false }
    var styled = false
    attributedText.enumerateAttribute(.backgroundColor, in: NSRange(location: 0, length: attributedText.length)) { value, _, stop in
      if value != nil {
        styled = true
        stop.pointee = true
      }
    }
    return styled
  }
}
