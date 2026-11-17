import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

final class PasteButtonView: ExpoView {
  let onPaste = EventDispatcher()
  private var control: UIPasteControl?
  var tint: UIColor? { didSet { rebuild() } }
  var display: UIPasteControl.DisplayMode = .iconAndLabel { didSet { if display != oldValue { rebuild() } } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    pasteConfiguration = UIPasteConfiguration(forAccepting: NSString.self)
    rebuild()
  }

  private func rebuild() {
    control?.removeFromSuperview()
    let configuration = UIPasteControl.Configuration()
    configuration.displayMode = display
    configuration.cornerStyle = .capsule
    if let tint { configuration.baseBackgroundColor = tint }
    let made = UIPasteControl(configuration: configuration)
    made.target = self
    made.frame = bounds
    made.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(made)
    control = made
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    control?.frame = bounds
  }

  override func canPaste(_ itemProviders: [NSItemProvider]) -> Bool {
    itemProviders.contains { $0.canLoadObject(ofClass: NSString.self) }
  }

  override func paste(itemProviders: [NSItemProvider]) {
    guard let provider = itemProviders.first(where: { $0.canLoadObject(ofClass: NSString.self) }) else { return }
    _ = provider.loadObject(ofClass: NSString.self) { [weak self] value, _ in
      guard let text = value as? String else { return }
      DispatchQueue.main.async { self?.onPaste(["text": text]) }
    }
  }
}

public final class PasteButtonModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhonePasteButton")

    View(PasteButtonView.self) {
      Events("onPaste")

      Prop("tint") { (view: PasteButtonView, color: UIColor?) in
        view.tint = color
      }

      Prop("display") { (view: PasteButtonView, value: String?) in
        view.display = switch value {
        case "labelOnly": .labelOnly
        case "iconOnly": .iconOnly
        default: .iconAndLabel
        }
      }
    }
  }
}
