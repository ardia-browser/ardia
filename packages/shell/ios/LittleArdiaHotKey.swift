import AppKit
import ArdiaCore
import Carbon.HIToolbox

final class LittleArdiaHotKey {
  static let shared = LittleArdiaHotKey()

  private struct Binding: Equatable {
    let keyCode: UInt32
    let modifiers: UInt32
  }

  private static let signature: OSType = 0x4152_4C41
  private static let hotKeyId: UInt32 = 0x4C41
  private static let summonWindow: TimeInterval = 2
  private static let specialKeys: [String: Int] = [
    "\r": kVK_Return, "\t": kVK_Tab, " ": kVK_Space, "\u{8}": kVK_Delete, "\u{1b}": kVK_Escape,
    MainMenu.functionKey(NSDeleteFunctionKey): kVK_ForwardDelete, MainMenu.functionKey(NSHomeFunctionKey): kVK_Home,
    MainMenu.functionKey(NSEndFunctionKey): kVK_End, MainMenu.functionKey(NSPageUpFunctionKey): kVK_PageUp,
    MainMenu.functionKey(NSPageDownFunctionKey): kVK_PageDown, MainMenu.leftArrow: kVK_LeftArrow,
    MainMenu.rightArrow: kVK_RightArrow, MainMenu.functionKey(NSUpArrowFunctionKey): kVK_UpArrow,
    MainMenu.functionKey(NSDownArrowFunctionKey): kVK_DownArrow,
  ]
  private static let functionKeyCodes = [
    kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
    kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20,
  ]

  private var registered: (binding: Binding, ref: EventHotKeyRef)?
  private var refused: Binding?
  private var announced: Binding?
  private var handlers: [EventHandlerRef] = []
  private var summonedAt: Date?
  private var started = false

  private init() {}

  func start() {
    guard !started else { return }
    started = true
    let center = NotificationCenter.default
    for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification] {
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.refresh() }
    }
    let inputSourceChanged = Notification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String)
    DistributedNotificationCenter.default().addObserver(forName: inputSourceChanged, object: nil, queue: .main) { [weak self] _ in
      self?.refresh()
    }
    refresh()
  }

  func refresh() {
    guard started else { return }
    let wanted = listens ? boundBinding() : nil
    if registered?.binding == wanted { return }
    unregister()
    if let wanted { register(wanted) }
  }

  func pressed() {
    if registered != nil { NSLog("[littleArdia] shortcut pressed in another app") }
    summonedAt = Date()
    ShellEvents.send(.app, ["type": "littleArdiaSummoned"])
    MenuTarget.shared.dispatch(CommandTable.Command.newLittleArdia.rawValue, nil, windowId: nil)
  }

  func takeSummon() -> Bool {
    guard let at = summonedAt else { return false }
    summonedAt = nil
    return Date().timeIntervalSince(at) < Self.summonWindow
  }

  func bringForward(_ window: NSWindow, keepingKey makeKey: @escaping () -> Void) {
    if LaunchConfig.shared.background {
      NSLog("[littleArdia] opened from another app (background mode, not activated)")
      return
    }
    guard !NSApp.isActive else { return makeKey() }
    window.makeMain()
    window.makeKey()
    var observer: NSObjectProtocol?
    let stopWatching = {
      if let observer { NotificationCenter.default.removeObserver(observer) }
      observer = nil
    }
    observer = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
      stopWatching()
      makeKey()
      DispatchQueue.main.async(execute: makeKey)
    }
    NSApp.activate()
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.summonWindow) {
      guard observer != nil else { return }
      stopWatching()
      NSLog("[littleArdia] the app didn't become active after the shortcut opened Little Ardia")
    }
  }

  var state: [String: Any] {
    let bound = boundBinding()
    return [
      "enabled": MenuState.current.littleArdiaFromOtherApps, "listens": listens, "registered": registered != nil,
      "keyCode": bound.map { Int($0.keyCode) } ?? NSNull(), "modifiers": bound.map { Int($0.modifiers) } ?? NSNull(),
    ]
  }

  private var listens: Bool {
    MenuState.current.fromApp && MenuState.current.littleArdiaFromOtherApps && !NSApp.isActive && !LaunchConfig.shared.background
  }

  private func boundBinding() -> Binding? {
    guard let shortcut = MainMenu.boundShortcut(of: CommandTable.Command.newLittleArdia.rawValue) else { return nil }
    let modifiers = Self.carbonModifiers(shortcut.mods)
    guard modifiers & UInt32(cmdKey | controlKey | optionKey) != 0, let keyCode = Self.keyCode(for: shortcut.key, modifiers: modifiers) else { return nil }
    return Binding(keyCode: keyCode, modifiers: modifiers)
  }

  private func register(_ binding: Binding) {
    guard refused != binding else { return }
    installHandlers()
    var ref: EventHotKeyRef?
    let id = EventHotKeyID(signature: Self.signature, id: Self.hotKeyId)
    let status = RegisterEventHotKey(binding.keyCode, binding.modifiers, id, GetEventDispatcherTarget(), 0, &ref)
    guard status == noErr, let ref else {
      refused = binding
      NSLog("[littleArdia] the shortcut for other apps wasn't registered (%d); another app may hold it", status)
      return
    }
    refused = nil
    registered = (binding, ref)
    if announced != binding {
      announced = binding
      NSLog("[littleArdia] shortcut for other apps registered (key code %d, modifiers %d)", binding.keyCode, binding.modifiers)
    }
  }

  private func unregister() {
    guard let (_, ref) = registered else { return }
    UnregisterEventHotKey(ref)
    registered = nil
  }

  private func installHandlers() {
    guard handlers.isEmpty else { return }
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let handle: EventHandlerUPP = { _, event, _ in
      var id = EventHotKeyID()
      let status = GetEventParameter(
        event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
      guard status == noErr, id.signature == LittleArdiaHotKey.signature, id.id == LittleArdiaHotKey.hotKeyId else {
        return OSStatus(eventNotHandledErr)
      }
      DispatchQueue.main.async { LittleArdiaHotKey.shared.pressed() }
      return noErr
    }
    for target in [GetEventDispatcherTarget(), GetApplicationEventTarget()] {
      var handler: EventHandlerRef?
      if InstallEventHandler(target, handle, 1, &spec, nil, &handler) == noErr, let handler { handlers.append(handler) }
    }
  }

  private static func carbonModifiers(_ flags: NSEvent.ModifierFlags) -> UInt32 {
    var modifiers = 0
    if flags.contains(.command) { modifiers |= cmdKey }
    if flags.contains(.option) { modifiers |= optionKey }
    if flags.contains(.control) { modifiers |= controlKey }
    if flags.contains(.shift) { modifiers |= shiftKey }
    return UInt32(modifiers)
  }

  private static func keyCode(for key: String, modifiers: UInt32) -> UInt32? {
    if let special = specialKeys[key] { return UInt32(special) }
    if let scalar = key.unicodeScalars.first, key.unicodeScalars.count == 1 {
      let index = Int(scalar.value) - NSF1FunctionKey
      if functionKeyCodes.indices.contains(index) { return UInt32(functionKeyCodes[index]) }
    }
    let layer = (modifiers & UInt32(cmdKey)) >> 8
    let layouts = [TISCopyCurrentKeyboardLayoutInputSource(), TISCopyCurrentASCIICapableKeyboardLayoutInputSource()]
      .compactMap { $0?.takeRetainedValue() }
    for layout in layouts {
      if let code = layoutKeyCode(for: key.lowercased(), in: layout, layer: layer) { return code }
    }
    return nil
  }

  private static func layoutKeyCode(for character: String, in source: TISInputSource, layer: UInt32) -> UInt32? {
    guard let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
    let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
    return data.withUnsafeBytes { raw -> UInt32? in
      guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
      for code in 0..<UInt16(128) {
        var deadKeys: UInt32 = 0
        var length = 0
        var chars = [UniChar](repeating: 0, count: 4)
        let status = UCKeyTranslate(
          layout, code, UInt16(kUCKeyActionDisplay), layer, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit),
          &deadKeys, chars.count, &length, &chars)
        if status == noErr, length > 0, String(utf16CodeUnits: chars, count: length).lowercased() == character { return UInt32(code) }
      }
      return nil
    }
  }
}
