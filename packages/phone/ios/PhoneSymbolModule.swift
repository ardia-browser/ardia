import ExpoModulesCore
import UIKit

final class PhoneSymbolView: ExpoView {
  private let imageView = UIImageView()
  var symbolName = "" { didSet { if symbolName != oldValue { refresh() } } }
  var pointSize: CGFloat = 17 { didSet { if pointSize != oldValue { refresh() } } }
  var weight: UIImage.SymbolWeight = .regular { didSet { if weight != oldValue { refresh() } } }
  var color: UIColor? { didSet { imageView.tintColor = color ?? .label } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    imageView.contentMode = .center
    imageView.tintColor = .label
    addSubview(imageView)
  }

  private func refresh() {
    let configuration = UIImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
    imageView.image = UIImage(systemName: symbolName, withConfiguration: configuration)
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
  }
}

public final class PhoneSymbolModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneSymbol")

    Function("exists") { (name: String) -> Bool in
      UIImage(systemName: name) != nil
    }

    View(PhoneSymbolView.self) {
      Prop("name") { (view: PhoneSymbolView, value: String) in
        view.symbolName = value
      }

      Prop("pointSize") { (view: PhoneSymbolView, value: Double?) in
        view.pointSize = CGFloat(value ?? 17)
      }

      Prop("weight") { (view: PhoneSymbolView, value: String?) in
        view.weight = switch value {
        case "ultralight": .ultraLight
        case "thin": .thin
        case "light": .light
        case "medium": .medium
        case "semibold": .semibold
        case "bold": .bold
        case "heavy": .heavy
        default: .regular
        }
      }

      Prop("color") { (view: PhoneSymbolView, value: UIColor?) in
        view.color = value
      }
    }
  }
}
