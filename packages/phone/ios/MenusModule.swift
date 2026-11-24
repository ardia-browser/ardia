import ExpoModulesCore
import UIKit

struct MenuItemRecord: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var subtitle: String? = nil
  @Field var systemImage: String? = nil
  @Field var destructive: Bool = false
  @Field var disabled: Bool = false
  @Field var checked: Bool = false
  @Field var inline: Bool = false
  @Field var children: [MenuItemRecord]? = nil
}

struct MenuAppearanceRecord: Record {
  @Field var dark: Bool? = nil
}

struct ActionSheetActionRecord: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var destructive: Bool = false
  @Field var cancel: Bool = false
}

struct ActionSheetRecord: Record {
  @Field var title: String? = nil
  @Field var message: String? = nil
  @Field var actions: [ActionSheetActionRecord] = []
  @Field var appearance: MenuAppearanceRecord? = nil
}

enum MenuBuilder {
  static func menu(_ items: [MenuItemRecord], select: @escaping (String) -> Void) -> UIMenu {
    UIMenu(children: items.map { element($0, select: select) })
  }

  static func style(_ dark: Bool?) -> UIUserInterfaceStyle {
    switch dark {
    case true?: .dark
    case false?: .light
    case nil: .unspecified
    }
  }

  private static func element(_ item: MenuItemRecord, select: @escaping (String) -> Void) -> UIMenuElement {
    let image = item.systemImage.flatMap { UIImage(systemName: $0) }
    if let children = item.children {
      var options: UIMenu.Options = item.inline ? [.displayInline] : []
      if item.destructive { options.insert(.destructive) }
      let submenu = UIMenu(title: item.title, image: image, identifier: nil, options: options, children: children.map { element($0, select: select) })
      submenu.subtitle = item.subtitle
      return submenu
    }
    var attributes: UIMenuElement.Attributes = []
    if item.destructive { attributes.insert(.destructive) }
    if item.disabled { attributes.insert(.disabled) }
    let id = item.id
    let action = UIAction(title: item.title, subtitle: item.subtitle, image: image, attributes: attributes, state: item.checked ? .on : .off) { _ in select(id) }
    return action
  }
}

final class MenuButton: UIButton {
  var opened: (() -> Void)?
  var closed: (() -> Void)?

  override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration, animator: (any UIContextMenuInteractionAnimating)?) {
    super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
    opened?()
  }

  override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: (any UIContextMenuInteractionAnimating)?) {
    super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
    closed?()
  }
}

final class ContextMenuView: ExpoView, UIContextMenuInteractionDelegate {
  let onSelect = EventDispatcher()
  let onOpen = EventDispatcher()
  let onClose = EventDispatcher()

  var items: [MenuItemRecord] = [] { didSet { refreshMenu() } }
  var fixedOrder = false { didSet { refreshMenu() } }
  var dark: Bool? { didSet { applyStyle() } }
  var trigger = "longPress" { didSet { if trigger != oldValue { applyTrigger() } } }

  private var interaction: UIContextMenuInteraction?
  private var tapButton: MenuButton?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    applyTrigger()
  }

  override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    insertSubview(childComponentView, at: index)
    if let tapButton { bringSubviewToFront(tapButton) }
  }

  override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    childComponentView.removeFromSuperview()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    tapButton?.frame = bounds
  }

  private func applyTrigger() {
    if let interaction { removeInteraction(interaction) }
    interaction = nil
    tapButton?.removeFromSuperview()
    tapButton = nil
    if trigger == "tap" {
      let button = MenuButton(type: .custom)
      button.opened = { [weak self] in self?.onOpen() }
      button.closed = { [weak self] in self?.onClose() }
      button.frame = bounds
      button.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      button.showsMenuAsPrimaryAction = true
      button.isAccessibilityElement = false
      addSubview(button)
      tapButton = button
    } else {
      let made = UIContextMenuInteraction(delegate: self)
      addInteraction(made)
      interaction = made
    }
    refreshMenu()
    applyStyle()
  }

  private func applyStyle() {
    overrideUserInterfaceStyle = MenuBuilder.style(dark)
  }

  private func select(_ id: String) {
    onSelect(["id": id])
  }

  private func refreshMenu() {
    guard let tapButton else { return }
    tapButton.menu = MenuBuilder.menu(items) { [weak self] id in self?.select(id) }
    tapButton.preferredMenuElementOrder = fixedOrder ? .fixed : .automatic
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
    guard !items.isEmpty else { return nil }
    let configuration = UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      guard let self else { return nil }
      return MenuBuilder.menu(self.items) { [weak self] id in self?.select(id) }
    }
    configuration.preferredMenuElementOrder = fixedOrder ? .fixed : .automatic
    return configuration
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration, highlightPreviewForItemWithIdentifier identifier: any NSCopying) -> UITargetedPreview? {
    targetedPreview()
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration, dismissalPreviewForItemWithIdentifier identifier: any NSCopying) -> UITargetedPreview? {
    targetedPreview()
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration, animator: (any UIContextMenuInteractionAnimating)?) {
    onOpen()
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: (any UIContextMenuInteractionAnimating)?) {
    onClose()
  }

  private func targetedPreview() -> UITargetedPreview? {
    guard window != nil, bounds.width > 0, bounds.height > 0 else { return nil }
    let parameters = UIPreviewParameters()
    let radius = max(layer.cornerRadius, subviews.first(where: { $0 !== tapButton })?.layer.cornerRadius ?? 0)
    parameters.visiblePath = UIBezierPath(roundedRect: bounds, cornerRadius: radius)
    parameters.backgroundColor = .clear
    return UITargetedPreview(view: self, parameters: parameters)
  }
}

public final class MenusModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneMenus")

    Constant("hasContextMenu") { true }
    Constant("hasActionSheet") { true }

    AsyncFunction("actionSheet") { (options: ActionSheetRecord, promise: Promise) in
      MainActor.assumeIsolated {
        guard let top = Self.topViewController() else {
          promise.resolve(nil)
          return
        }
        let sheet = UIAlertController(title: options.title, message: options.message, preferredStyle: .actionSheet)
        sheet.overrideUserInterfaceStyle = MenuBuilder.style(options.appearance?.dark)
        var answered = false
        let answer = { (id: String?) in
          guard !answered else { return }
          answered = true
          promise.resolve(id)
        }
        for action in options.actions {
          let style: UIAlertAction.Style = action.cancel ? .cancel : action.destructive ? .destructive : .default
          let id = action.id
          sheet.addAction(UIAlertAction(title: action.title, style: style) { _ in answer(action.cancel ? nil : id) })
        }
        if !options.actions.contains(where: \.cancel) {
          sheet.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel) { _ in answer(nil) })
        }
        if let popover = sheet.popoverPresentationController {
          popover.sourceView = top.view
          popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
          popover.permittedArrowDirections = []
        }
        top.present(sheet, animated: true)
      }
    }.runOnQueue(.main)

    View(ContextMenuView.self) {
      Events("onSelect", "onOpen", "onClose")

      Prop("items") { (view: ContextMenuView, items: [MenuItemRecord]) in
        view.items = items
      }

      Prop("trigger") { (view: ContextMenuView, value: String?) in
        view.trigger = value == "tap" ? "tap" : "longPress"
      }

      Prop("fixedOrder") { (view: ContextMenuView, value: Bool?) in
        view.fixedOrder = value ?? false
      }

      Prop("appearance") { (view: ContextMenuView, value: MenuAppearanceRecord?) in
        view.dark = value?.dark
      }
    }
  }

  @MainActor private static func topViewController() -> UIViewController? {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    var top = (windows.first(where: \.isKeyWindow) ?? windows.first)?.rootViewController
    while let presented = top?.presentedViewController, !presented.isBeingDismissed { top = presented }
    return top
  }
}
