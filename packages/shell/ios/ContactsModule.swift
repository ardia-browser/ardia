import AppKit
import ArdiaCore
import Contacts
import ExpoModulesCore

public class ContactsModule: Module, ContactsNative {
  private let store = CNContactStore()
  private var observer: NSObjectProtocol?
  private var fixtureWatch: DispatchSourceFileSystemObject?

  private static let fixturePath: String? = {
    #if DEBUG
      return LaunchConfig.shared.testValue("meCard")
    #else
      return nil
    #endif
  }()

  static func authorizationStatus() -> String {
    if fixturePath != nil { return "authorized" }
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    default: return "limited"
    }
  }

  func requestAccess(_ promise: Promise) {
    let status = Self.authorizationStatus()
    guard status == "notDetermined", !LaunchConfig.shared.background else {
      if status == "notDetermined" { NSLog("[contacts] background instance: not asking for Contacts") }
      return promise.resolve(["granted": Self.readable(status), "status": status, "error": NSNull()])
    }
    store.requestAccess(for: .contacts) { granted, error in
      DispatchQueue.main.async {
        let now = Self.authorizationStatus()
        if !granted { NSLog("[contacts] access not granted: now %@", now) }
        promise.resolve(["granted": granted, "status": now, "error": error?.localizedDescription as Any])
      }
    }
  }

  func meCard() -> [String: Any]? {
    if let path = Self.fixturePath { return Self.fixtureCard(path) }
    guard Self.readable(Self.authorizationStatus()) else { return nil }
    let keys: [CNKeyDescriptor] = [
      CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
      CNContactOrganizationNameKey as CNKeyDescriptor,
      CNContactEmailAddressesKey as CNKeyDescriptor,
      CNContactPhoneNumbersKey as CNKeyDescriptor,
      CNContactPostalAddressesKey as CNKeyDescriptor,
    ]
    guard let me = try? store.unifiedMeContactWithKeys(toFetch: keys) else { return nil }
    return [
      "name": CNContactFormatter.string(from: me, style: .fullName) ?? "",
      "organization": me.organizationName,
      "emails": me.emailAddresses.map { $0.value as String },
      "phones": me.phoneNumbers.map { $0.value.stringValue },
      "addresses": me.postalAddresses.map { Self.address($0.value) },
    ]
  }

  func openMeCard() {
    if LaunchConfig.shared.background { return NSLog("[contacts] background instance: would open the Me card in Contacts") }
    let id = (try? store.unifiedMeContactWithKeys(toFetch: [CNContactIdentifierKey as CNKeyDescriptor]))?.identifier
    if let id, let url = URL(string: "addressbook://\(id)"), NSWorkspace.shared.open(url) { return }
    guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.AddressBook") else { return }
    NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
  }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)
    Self.eventsDefinition

    OnStartObserving("onContactsChanged") {
      self.observe()
    }

    OnStopObserving("onContactsChanged") {
      self.stopObserving()
    }

    Self.authorizationStatusFunction

    requestAccessFunction

    meCardFunction

    openMeCardFunction
  }

  private func observe() {
    stopObserving()
    if let path = Self.fixturePath { return watchFixture(path) }
    observer = NotificationCenter.default.addObserver(forName: .CNContactStoreDidChange, object: nil, queue: .main) { [weak self] _ in
      self?.sendOnContactsChanged([:])
    }
  }

  private func stopObserving() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
    fixtureWatch?.cancel()
    fixtureWatch = nil
  }

  private func watchFixture(_ path: String) {
    fixtureWatch?.cancel()
    let descriptor = open(path, O_EVTONLY)
    guard descriptor >= 0 else { return }
    let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .extend, .delete, .rename], queue: .main)
    source.setEventHandler { [weak self, weak source] in
      guard let self, let source else { return }
      let replaced = !source.data.intersection([.delete, .rename]).isEmpty
      self.sendOnContactsChanged([:])
      if replaced { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.watchFixture(path) } }
    }
    source.setCancelHandler { close(descriptor) }
    source.resume()
    fixtureWatch = source
  }

  private static func readable(_ status: String) -> Bool { status == "authorized" || status == "limited" }

  private static func address(_ a: CNPostalAddress) -> [String: String] {
    [
      "street": a.street,
      "city": a.city,
      "state": a.state,
      "postalCode": a.postalCode,
      "country": a.isoCountryCode.isEmpty ? a.country : a.isoCountryCode.uppercased(),
    ]
  }

  private static func fixtureCard(_ path: String) -> [String: Any]? {
    guard let data = FileManager.default.contents(atPath: path), let card = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return card
  }
}
