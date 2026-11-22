import AppKit
import ArdiaCore
import Carbon.HIToolbox

final class LittleArdiaHotKey {
  static let shared = LittleArdiaHotKey()

  struct Chord: Equatable {
    let keyCode: UInt32
    let modifiers: UInt32
  }

  fileprivate static let signature: OSType = 0x4172_4C41
  private static let pressWindow: TimeInterval = 2
  private static let command = "newLittleArdia"

  private var hotKey: EventHotKeyRef?
  private var handler: EventHandlerRef?
  private(set) var registered: Chord?
  private(set) var heldBack: Chord?
  private var pressedAt: Date?
  private var started = false

  private init() {}

  func start() {
    guard !started else { return }
    started = true
    let center = NotificationCenter.default
    for name in [NSApplication.didResignActiveNotification, NSApplication.didBecomeActiveNotification] {
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.update() }
    }
    let layoutChanged = NSNotification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String)
    DistributedNotificationCenter.default().addObserver(forName: layoutChanged, object: nil, queue: .main) { [weak self] _ in
      self?.update()
    }
    update()
  }

  func shortcutsChanged() {
    if started { update() }
  }

  func takePress() -> Bool {
    guard let pressedAt, Date().timeIntervalSince(pressedAt) < Self.pressWindow else { return false }
    self.pressedAt = nil
    return true
  }

  func state() -> [String: Any] {
    let chord = Self.chord()
    return [
      "binding": chord.map { ["keyCode": $0.keyCode, "modifiers": $0.modifiers] } as Any,
      "registered": registered != nil,
      "heldBack": heldBack != nil,
      "active": NSApp.isActive,
    ]
  }

  func press() {
    pressedAt = Date()
    ShellEvents.send(.app, ["type": "littleArdiaGlobalShortcut"])
    MenuTarget.shared.dispatch(Self.command, nil, windowId: nil)
  }

  private func update() {
    let wanted = NSApp.isActive || !MenuState.current.littleArdiaShortcutFromAnyApp ? nil : Self.chord()
    if wanted == (registered ?? heldBack) { return }
    unregister()
    guard let wanted else { return }
    if LaunchConfig.shared.background {
      heldBack = wanted
      NSLog("[littleArdia] global shortcut %u/%u not registered (background mode)", wanted.keyCode, wanted.modifiers)
      return
    }
    register(wanted)
  }

  private func register(_ chord: Chord) {
    installHandler()
    var ref: EventHotKeyRef?
    let id = EventHotKeyID(signature: Self.signature, id: 1)
    let status = RegisterEventHotKey(chord.keyCode, chord.modifiers, id, GetApplicationEventTarget(), 0, &ref)
    guard status == noErr, let ref else {
      NSLog("[littleArdia] global shortcut %u/%u taken (%d)", chord.keyCode, chord.modifiers, status)
      return
    }
    hotKey = ref
    registered = chord
  }

  private func unregister() {
    if let hotKey { UnregisterEventHotKey(hotKey) }
    hotKey = nil
    registered = nil
    heldBack = nil
  }

  private func installHandler() {
    guard handler == nil else { return }
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
      var id = EventHotKeyID()
      let status = GetEventParameter(
        event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
        MemoryLayout<EventHotKeyID>.size, nil, &id)
      guard status == noErr, id.signature == LittleArdiaHotKey.signature else { return OSStatus(eventNotHandledErr) }
      DispatchQueue.main.async { LittleArdiaHotKey.shared.press() }
      return noErr
    }, 1, &spec, nil, &handler)
  }

  static var bindingHoldsFunction = false {
    didSet { if oldValue != bindingHoldsFunction { shared.shortcutsChanged() } }
  }

  static func holdsFunction(_ bindings: [String: [[String]]]) -> Bool {
    bindings[command]?.first?.dropFirst().contains(ModifierName.function.rawValue) == true
  }

  static func chord() -> Chord? {
    guard let item = commandItem(in: NSApp.mainMenu), !item.keyEquivalent.isEmpty,
      let keyCode = keyCode(for: item.keyEquivalent)
    else { return nil }
    var mods = item.keyEquivalentModifierMask
    if item.keyEquivalent != item.keyEquivalent.lowercased() { mods.insert(.shift) }
    let carbon = GlobalChordRule.modifiers(
      command: mods.contains(.command), option: mods.contains(.option), control: mods.contains(.control), shift: mods.contains(.shift))
    guard GlobalChordRule.registrable(key: item.keyEquivalent, modifiers: carbon, function: mods.contains(.function) || bindingHoldsFunction) else { return nil }
    return Chord(keyCode: keyCode, modifiers: carbon)
  }

  private static func commandItem(in menu: NSMenu?) -> CommandItem? {
    for item in menu?.items ?? [] {
      if let command = item as? CommandItem, command.command == Self.command, command.arg == nil, !command.isAlternate {
        return command
      }
      if let found = commandItem(in: item.submenu) { return found }
    }
    return nil
  }

  private static let functionKeys: [Int: Int] = [
    NSLeftArrowFunctionKey: kVK_LeftArrow, NSRightArrowFunctionKey: kVK_RightArrow, NSUpArrowFunctionKey: kVK_UpArrow,
    NSDownArrowFunctionKey: kVK_DownArrow, NSF1FunctionKey: kVK_F1, NSF2FunctionKey: kVK_F2, NSF3FunctionKey: kVK_F3,
    NSF4FunctionKey: kVK_F4, NSF5FunctionKey: kVK_F5, NSF6FunctionKey: kVK_F6, NSF7FunctionKey: kVK_F7,
    NSF8FunctionKey: kVK_F8, NSF9FunctionKey: kVK_F9, NSF10FunctionKey: kVK_F10, NSF11FunctionKey: kVK_F11,
    NSF12FunctionKey: kVK_F12, NSF13FunctionKey: kVK_F13, NSF14FunctionKey: kVK_F14, NSF15FunctionKey: kVK_F15,
    NSF16FunctionKey: kVK_F16, NSF17FunctionKey: kVK_F17, NSF18FunctionKey: kVK_F18, NSF19FunctionKey: kVK_F19,
    NSF20FunctionKey: kVK_F20, NSHomeFunctionKey: kVK_Home, NSEndFunctionKey: kVK_End, NSPageUpFunctionKey: kVK_PageUp,
    NSPageDownFunctionKey: kVK_PageDown, NSDeleteFunctionKey: kVK_ForwardDelete, 0x0D: kVK_Return, 0x09: kVK_Tab,
    0x20: kVK_Space, 0x08: kVK_Delete, 0x7F: kVK_Delete, 0x1B: kVK_Escape,
  ]

  static func keyCode(for key: String) -> UInt32? {
    guard let scalar = key.unicodeScalars.first, key.unicodeScalars.count == 1 else { return nil }
    if let code = functionKeys[Int(scalar.value)] { return UInt32(code) }
    let wanted = key.lowercased()
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return nil }
    let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
    return data.withUnsafeBytes { raw -> UInt32? in
      guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
      for code in 0..<UInt16(128) {
        var dead: UInt32 = 0
        var length = 0
        var chars = [UniChar](repeating: 0, count: 4)
        let status = UCKeyTranslate(
          layout, code, UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit),
          &dead, chars.count, &length, &chars)
        if status == noErr, length > 0, String(utf16CodeUnits: chars, count: length).lowercased() == wanted { return UInt32(code) }
      }
      return nil
    }
  }
}
