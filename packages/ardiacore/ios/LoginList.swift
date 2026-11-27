import AppKit

protocol LoginListTarget: AnyObject {
  var loginListProfile: String { get }
  var loginListPage: URL? { get }
  var loginListWindow: NSWindow? { get }
  func loginListFill(username: String, password: String, frameOrigin: String, done: @escaping (Bool) -> Void)
  func loginListSync(open: Bool, picking: Bool)
  func loginListConnect()
}

struct LoginListField {
  enum Trigger { case press, typing }

  let frameOrigin: String
  let screenRect: NSRect
  let trigger: Trigger
  let typed: String
}

final class LoginList: NSObject {
  static let shared = LoginList()
  static let passwordsApp = "com.apple.Passwords"
  static let iconLabel = "Apple Passwords"
  static let footerId = "openPasswordsApp"
  static let footerTitle = "Open Passwords app"
  static let noLogins = "No saved logins"
  static let insecure = "Not secure"
  static let fillFailed = "Apple Passwords didn't fill this login. Unlock the Passwords app and try again."
  static let connectId = "connectApplePasswords"
  static let connectTitle = "Connect Apple Passwords"
  static let notNowId = "notNow"
  static let notNowTitle = "Not now"

  private struct Shown {
    weak var target: LoginListTarget?
    let field: LoginListField
    let page: String
    let host: String
    let site: String
    var logins: [ApplePasswordsMatch.Login]
    var connect = false
  }

  private var shown: Shown?
  private var ticket = 0
  private var declined: Set<String> = []
  private var resume: Shown?

  override init() {
    super.init()
    NotificationCenter.default.addObserver(forName: ApplePasswordsClient.changed, object: nil, queue: .main) { [weak self] note in
      self?.applePasswordsChanged(note.userInfo?["state"] as? String ?? "")
    }
  }
  private lazy var dropdown: WebKitAutofillDropdown = {
    let dropdown = WebKitAutofillDropdown()
    dropdown.onPick = { [weak self] row in self?.picked(row.id) }
    dropdown.onSelect = { [weak self] in self?.sync() }
    dropdown.onDismiss = { [weak self] in
      self?.sync()
      self?.shown = nil
    }
    return dropdown
  }()

  static func origin(of url: URL?) -> String? { url.flatMap { Origins.of($0) }.map(WebKitLogins.normalized) }

  func isShown(for target: LoginListTarget) -> Bool { dropdown.isShown && shown?.target === target }

  func show(_ target: LoginListTarget, field: LoginListField) {
    ticket += 1
    let asked = ticket
    guard let frame = URL(string: field.frameOrigin), let scheme = frame.scheme?.lowercased(), scheme == "https" || scheme == "http",
      let host = frame.host?.lowercased(), !host.isEmpty, let page = Self.origin(of: target.loginListPage), let pageHost = target.loginListPage?.host?.lowercased()
    else { return close(target) }
    let profile = target.loginListProfile
    resume = nil
    ApplePasswordsClient.shared.logins(host: host) { [weak self, weak target] result in
      let entries = (try? result.get()) ?? []
      Self.domains(ApplePasswordsMatch.probes([host, pageHost] + ApplePasswordsMatch.siteHosts(entries)), profile: profile) { domains in
        guard let self, let target, asked == self.ticket, Self.origin(of: target.loginListPage) == page else { return }
        guard ApplePasswordsMatch.sameSite(host, pageHost, domains: domains) else { return self.close(target) }
        let site = domains[pageHost] ?? pageHost
        switch result {
        case .success:
          let logins = ApplePasswordsMatch.logins(entries, scheme: scheme, host: host, domains: domains)
          self.present(Shown(target: target, field: field, page: page, host: host, site: site, logins: logins), notice: nil)
        case .failure(.notConnected):
          self.offerConnect(Shown(target: target, field: field, page: page, host: host, site: site, logins: []))
        case .failure(let problem):
          self.present(Shown(target: target, field: field, page: page, host: host, site: site, logins: []), notice: Self.notice(problem))
        }
      }
    }
  }

  static func domains(_ hosts: [String], profile: String, done: @escaping ([String: String]) -> Void) {
    DispatchQueue.main.async {
      ArdiaServices.call("ac_registrable_domains", profile: ArdiaHost.baseProfile(of: profile), args: ["hosts": hosts]) { result in
        let answers = result["domains"] as? [String] ?? []
        let domains = answers.count == hosts.count ? Dictionary(zip(hosts, answers), uniquingKeysWith: { first, _ in first }) : [:]
        DispatchQueue.main.async { done(domains) }
      }
    }
  }

  private func offerConnect(_ next: Shown) {
    guard let target = next.target else { return }
    guard !declined.contains(next.site) else { return close(target) }
    var offer = next
    offer.connect = true
    present(offer, notice: nil)
  }

  private func applePasswordsChanged(_ state: String) {
    guard state == "connected" else { return declined.removeAll() }
    guard let waiting = resume else { return }
    resume = nil
    guard let target = waiting.target, Self.origin(of: target.loginListPage) == waiting.page else { return }
    show(target, field: waiting.field)
  }

  func pairingCancelled() { resume = nil }

  static func notice(_ problem: ApplePasswordsClient.Problem) -> String {
    switch problem {
    case .notConnected: "Apple Passwords isn't connected."
    case .refused: "Apple Passwords didn't share this site's logins. Unlock the Passwords app and try again."
    case .failed: "Apple Passwords didn't answer. Try again."
    case .unavailable(.helperMissing): "Apple Passwords' browser helper is missing from this Mac."
    case .unavailable(.tooOld): "Needs macOS 15.4 or later."
    case .unavailable(.notEntitled): "This copy of Ardia can't use Apple Passwords."
    case .unavailable: "Apple Passwords isn't available on this Mac."
    }
  }

  private static func rowId(_ login: ApplePasswordsMatch.Login) -> String { "login\n\(login.user)" }

  static let connectRows: [WebKitAutofillDropdown.Row] = [
    .init(id: connectId, title: connectTitle, detail: "", symbol: "key.fill", appIcon: passwordsApp, iconLabel: iconLabel),
    .init(id: notNowId, title: notNowTitle, detail: "", symbol: "xmark"),
  ]

  static func rows(_ logins: [ApplePasswordsMatch.Login], notice: String?, connect: Bool = false) -> [WebKitAutofillDropdown.Row] {
    if connect { return connectRows }
    var rows: [WebKitAutofillDropdown.Row] = []
    if let notice { rows.append(.init(id: "", title: notice, detail: "", symbol: "exclamationmark.circle", enabled: false)) }
    if logins.isEmpty, notice == nil { rows.append(.init(id: "", title: noLogins, detail: "", symbol: "key", enabled: false, appIcon: passwordsApp, iconLabel: iconLabel)) }
    rows += logins.map { login in
      let title = login.user.isEmpty ? "No username" : login.user
      return .init(id: rowId(login), title: title, detail: login.insecure ? insecure : "", symbol: "key.fill", muted: login.user.isEmpty, appIcon: passwordsApp, iconLabel: iconLabel)
    }
    rows.append(.init(id: footerId, title: footerTitle, detail: "", symbol: "arrow.up.forward.app"))
    return rows
  }

  private func present(_ next: Shown, notice: String?) {
    guard let target = next.target else { return }
    let logins = LoginListFilter.hits(next.logins.map(\.user), typed: next.field.typed).map { next.logins[$0.index] }
    let quiet = next.field.trigger == .typing && notice == nil && logins.isEmpty && !next.connect
    guard !quiet, let window = target.loginListWindow else { return close(target) }
    var current = next
    current.logins = logins
    shown = current
    let rows = Self.rows(logins, notice: notice, connect: next.connect)
    if LaunchConfig.shared.background { NSLog("[logins] Login list: %ld logins, %ld rows", logins.count, rows.count) }
    dropdown.show(rows, under: next.field.screenRect, in: window)
    sync()
    Self.count(next.connect ? "connectShown" : "shown")
  }

  func key(_ target: LoginListTarget, _ key: String) {
    guard isShown(for: target) else { return }
    switch key {
    case "down": dropdown.move(1)
    case "up": dropdown.move(-1)
    case "enter":
      guard let row = dropdown.selectedRow else { return close(target) }
      picked(row.id)
    default: close(target)
    }
  }

  func close(_ target: LoginListTarget) {
    guard shown == nil || shown?.target === target else { return }
    ticket += 1
    dropdown.close()
    sync()
    shown = nil
  }

  private func sync() {
    shown?.target?.loginListSync(open: dropdown.isShown, picking: dropdown.selectedRow != nil)
  }

  private func picked(_ id: String) {
    guard let current = shown, let target = current.target else { return }
    if id == Self.footerId {
      close(target)
      return Self.openPasswordsApp()
    }
    if id == Self.connectId {
      close(target)
      resume = current
      Self.count("connectPicked")
      return target.loginListConnect()
    }
    if id == Self.notNowId {
      close(target)
      declined.insert(current.site)
      return Self.count("notNow")
    }
    guard let login = current.logins.first(where: { Self.rowId($0) == id }) else { return }
    close(target)
    let asked = ticket
    ApplePasswordsClient.shared.password(host: current.host, user: login.user) { [weak self, weak target] result in
      DispatchQueue.main.async {
        guard let self, let target, Self.origin(of: target.loginListPage) == current.page else { return }
        switch result {
        case .success(let password):
          ApplePasswordsSaving.remember(scheme: login.insecure ? "http" : "https", host: current.host, user: login.user, password: password)
          target.loginListFill(username: login.user, password: password, frameOrigin: current.field.frameOrigin) { filled in
            Self.count(filled ? "filled" : "fillFailed")
          }
        case .failure(let problem):
          Self.count("fillFailed")
          guard asked == self.ticket else { return }
          if problem == .notConnected { return self.offerConnect(current) }
          self.present(current, notice: Self.fillFailed)
        }
      }
    }
  }

  static func openPasswordsApp() {
    if LaunchConfig.shared.background { return NSLog("[logins] Passwords app (background mode, not opened)") }
    guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: passwordsApp) else { return }
    NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
  }

  private static func count(_ name: String) {
    ArdiaEvents.emit("passwords.loginListCounted", data: ArdiaConsentStamp.begin().onto(["name": name]))
  }

  func forget(_ target: LoginListTarget) { close(target) }
}
