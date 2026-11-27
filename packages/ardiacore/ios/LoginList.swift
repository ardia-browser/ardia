import AppKit

protocol LoginListTarget: AnyObject {
  var loginListProfile: String { get }
  var loginListPage: URL? { get }
  var loginListWindow: NSWindow? { get }
  func loginListFill(username: String, password: String, frameOrigin: String, done: @escaping (Bool) -> Void)
  func loginListSync(open: Bool, picking: Bool)
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

  private struct Shown {
    weak var target: LoginListTarget?
    let field: LoginListField
    let page: String
    let host: String
    let logins: [ApplePasswordsMatch.Login]
  }

  private var shown: Shown?
  private var ticket = 0
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
    ApplePasswordsClient.shared.logins(host: host) { [weak self, weak target] result in
      let entries = (try? result.get()) ?? []
      Self.domains(ApplePasswordsMatch.probes([host, pageHost] + ApplePasswordsMatch.siteHosts(entries)), profile: profile) { domains in
        guard let self, let target, asked == self.ticket, Self.origin(of: target.loginListPage) == page else { return }
        guard ApplePasswordsMatch.sameSite(host, pageHost, domains: domains) else { return self.close(target) }
        switch result {
        case .success:
          let logins = ApplePasswordsMatch.logins(entries, scheme: scheme, host: host, domains: domains)
          self.present(Shown(target: target, field: field, page: page, host: host, logins: logins), notice: nil)
        case .failure(let problem):
          self.present(Shown(target: target, field: field, page: page, host: host, logins: []), notice: Self.notice(problem))
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

  static func notice(_ problem: ApplePasswordsClient.Problem) -> String {
    switch problem {
    case .notConnected: "Apple Passwords isn't connected. Connect it in Settings › Profiles › Passwords."
    case .refused: "Apple Passwords didn't share this site's logins. Unlock the Passwords app and try again."
    case .failed: "Apple Passwords didn't answer. Try again."
    case .unavailable(.helperMissing): "Apple Passwords' browser helper is missing from this Mac."
    case .unavailable(.tooOld): "Needs macOS 15.4 or later."
    case .unavailable(.notEntitled): "This copy of Ardia can't use Apple Passwords."
    case .unavailable: "Apple Passwords isn't available on this Mac."
    }
  }

  private static func rowId(_ login: ApplePasswordsMatch.Login) -> String { "login\n\(login.user)" }

  static func rows(_ logins: [ApplePasswordsMatch.Login], notice: String?) -> [WebKitAutofillDropdown.Row] {
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
    let typed = next.field.typed.lowercased()
    let logins = typed.isEmpty ? next.logins : next.logins.filter { $0.user.lowercased().hasPrefix(typed) }
    let quiet = next.field.trigger == .typing && notice == nil && logins.isEmpty
    guard !quiet, let window = target.loginListWindow else { return close(target) }
    shown = Shown(target: target, field: next.field, page: next.page, host: next.host, logins: logins)
    let rows = Self.rows(logins, notice: notice)
    if LaunchConfig.shared.background { NSLog("[logins] Login list: %ld logins, %ld rows", logins.count, rows.count) }
    dropdown.show(rows, under: next.field.screenRect, in: window)
    sync()
    Self.count("shown")
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
          let notice = problem == .notConnected ? Self.notice(problem) : Self.fillFailed
          self.present(current, notice: notice)
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
