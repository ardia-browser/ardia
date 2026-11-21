import Foundation
import Security

struct PluginSandbox {
  let home: String
  let appData: String
  let configFolder: String
  let pluginFolder: String
  let pluginData: String
  let program: String
  let network: Bool

  static let searchPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"]

  static let machAllowed = [
    "com.apple.system.opendirectoryd.libinfo", "com.apple.system.opendirectoryd.membership", "com.apple.logd", "com.apple.bsd.dirhelper",
    "com.apple.cfprefsd.agent", "com.apple.cfprefsd.daemon",
  ]

  static let machAllowedOnline = [
    "com.apple.SystemConfiguration.DNSConfiguration", "com.apple.SystemConfiguration.configd", "com.apple.trustd", "com.apple.trustd.agent",
    "com.apple.TrustEvaluationAgent",
  ]

  static let unixSocketsAllowedOnline = ["/private/var/run/mDNSResponder"]

  static let preferenceDomainsAllowed = ["kCFPreferencesAnyApplication"]

  static let devicesWritable = ["/dev/null", "/dev/zero"]

  static let unreadableTrees = ["/Users", "/Volumes"]

  static let proxyEnvironment = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"]

  static let certificateEnvironment = ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]

  static let systemCertificates = "/etc/ssl/cert.pem"

  static let certificateBundleName = "certificates.pem"

  static let certificateSourceLimit = 4 << 20

  static let extraCertificateBundleName = "extra-certificates.pem"

  struct Certificates: Equatable {
    var replacement: String
    var extra: String
  }

  struct NetworkEnvironment: Equatable {
    var variables: [String] = []
    var droppedProxies: [String] = []
  }

  static func carriesCredentials(_ value: String) -> Bool {
    guard let url = URL(string: value.contains("://") ? value : "http://\(value)") else { return value.contains("@") || value.contains("?") || value.contains("#") }
    return url.user != nil || url.password != nil || url.query != nil || url.fragment != nil || (url.host == nil && value.contains("@"))
  }

  static func derLength(_ der: Data) -> Int? {
    let bytes = [UInt8](der.prefix(6))
    guard bytes.count >= 2, bytes[0] == 0x30 else { return nil }
    if bytes[1] < 0x80 { return 2 + Int(bytes[1]) }
    let count = Int(bytes[1] & 0x7f)
    guard count >= 1, count <= 4, bytes.count >= 2 + count else { return nil }
    let length = bytes[2..<(2 + count)].reduce(0) { ($0 << 8) | Int($1) }
    return 2 + count + length
  }

  static func certificateDER(_ body: Substring) -> Data? {
    guard let der = Data(base64Encoded: String(body.filter { !$0.isWhitespace })), derLength(der) == der.count else { return nil }
    guard SecCertificateCreateWithData(nil, der as CFData) != nil else { return nil }
    return der
  }

  static func certificateBlocks(in text: String) -> [String] {
    let begin = "-----BEGIN CERTIFICATE-----"
    let end = "-----END CERTIFICATE-----"
    var blocks: [String] = []
    var body: [Substring]?
    for raw in text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" }) {
      let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if line.hasPrefix("-----BEGIN ") {
        body = line == begin ? [] : nil
        continue
      }
      if line.hasPrefix("-----END ") {
        if line == end, let lines = body, let der = certificateDER(Substring(lines.joined())) {
          blocks.append("\(begin)\n\(der.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed]))\n\(end)\n")
        }
        body = nil
        continue
      }
      body?.append(Substring(line))
    }
    return blocks
  }

  struct SourceIdentity: Equatable {
    let device: Int32
    let inode: UInt64
    let modified: timespec
    let changed: timespec
    let size: off_t

    init(_ info: stat) {
      device = info.st_dev
      inode = info.st_ino
      modified = info.st_mtimespec
      changed = info.st_ctimespec
      size = info.st_size
    }

    static func == (a: SourceIdentity, b: SourceIdentity) -> Bool {
      a.device == b.device && a.inode == b.inode && a.size == b.size && a.modified.tv_sec == b.modified.tv_sec && a.modified.tv_nsec == b.modified.tv_nsec
        && a.changed.tv_sec == b.changed.tv_sec && a.changed.tv_nsec == b.changed.tv_nsec
    }
  }

  static func identity(of path: String) -> SourceIdentity? {
    var info = stat()
    guard stat(path, &info) == 0 else { return nil }
    return SourceIdentity(info)
  }

  static func readSource(_ path: String, limit: Int = certificateSourceLimit) -> Data? {
    readIdentifiedSource(path, limit: limit)?.data
  }

  static func readIdentifiedSource(_ path: String, limit: Int = certificateSourceLimit) -> (data: Data, identity: SourceIdentity)? {
    let fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= off_t(limit) else { return nil }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while data.count <= limit {
      let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
      if count < 0 { return nil }
      if count == 0 { break }
      data.append(contentsOf: buffer[0..<count])
    }
    return data.count <= limit ? (data, SourceIdentity(info)) : nil
  }

  static func extraCertificateSources(from given: [String: String], system: String = systemCertificates) -> [String] {
    var sources: [String] = []
    for name in certificateEnvironment {
      if let path = given[name], !path.isEmpty, path != system, !sources.contains(path) { sources.append(path) }
    }
    return sources
  }

  struct LoadedCertificates {
    let certificates: Certificates
    let identities: [String: SourceIdentity]
    let complete: Bool
  }

  static func loadCertificates(from given: [String: String], system: String = systemCertificates) -> LoadedCertificates {
    var identities: [String: SourceIdentity] = [:]
    var complete = true
    func blocks(_ sources: [String]) -> [String] {
      sources.flatMap { source -> [String] in
        guard let read = readIdentifiedSource(source) else {
          complete = false
          return []
        }
        identities[source] = read.identity
        return certificateBlocks(in: String(decoding: read.data, as: UTF8.self))
      }
    }
    var seenSystem = Set<String>()
    let systemBlocks = blocks([system]).filter { seenSystem.insert($0).inserted }
    var seenExtra = Set<String>()
    let extraBlocks = blocks(extraCertificateSources(from: given, system: system)).filter { seenExtra.insert($0).inserted }
    let replacement = systemBlocks.isEmpty ? [] : systemBlocks + extraBlocks.filter { !seenSystem.contains($0) }
    return LoadedCertificates(certificates: Certificates(replacement: replacement.joined(), extra: extraBlocks.joined()), identities: identities, complete: complete)
  }

  static func certificates(from given: [String: String], system: String = systemCertificates) -> Certificates {
    loadCertificates(from: given, system: system).certificates
  }

  enum PreparedCertificates: Equatable {
    case offline, notConfigured, timedOut
    case ready(Certificates)
  }

  static func stage(_ prepared: PreparedCertificates, in directory: Int32) -> Certificates? {
    switch prepared {
    case .offline, .timedOut:
      return nil
    case .notConfigured:
      unlinkat(directory, certificateBundleName, 0)
      unlinkat(directory, extraCertificateBundleName, 0)
      return nil
    case .ready(let ready):
      var staged = Certificates(replacement: "", extra: "")
      if !ready.replacement.isEmpty, writeAtomically(in: directory, name: certificateBundleName, contents: ready.replacement) {
        staged.replacement = ready.replacement
      } else {
        unlinkat(directory, certificateBundleName, 0)
      }
      if !ready.extra.isEmpty, writeAtomically(in: directory, name: extraCertificateBundleName, contents: ready.extra) {
        staged.extra = ready.extra
      } else {
        unlinkat(directory, extraCertificateBundleName, 0)
      }
      return staged.replacement.isEmpty && staged.extra.isEmpty ? nil : staged
    }
  }

  static func certificateVariables(dataFolder: String, staged: Certificates?) -> [String] {
    let replacement = staged.map { !$0.replacement.isEmpty } == true ? (dataFolder as NSString).appendingPathComponent(certificateBundleName) : systemCertificates
    var variables = ["SSL_CERT_FILE=\(replacement)", "GIT_SSL_CAINFO=\(replacement)"]
    if let staged, !staged.extra.isEmpty { variables.append("NODE_EXTRA_CA_CERTS=\((dataFolder as NSString).appendingPathComponent(extraCertificateBundleName))") }
    return variables
  }

  static func helperEnvironment(
    name: String, data: OpenedFolder, channelFd: Int32, network: Bool, given: [String: String], certificates: PreparedCertificates
  ) -> NetworkEnvironment {
    let carried = networkEnvironment(from: given, network: network)
    let roots = network ? certificateVariables(dataFolder: data.path, staged: stage(certificates, in: data.fd)) : []
    let folder = data.path as NSString
    let base = [
      "PATH=" + searchPath.joined(separator: ":"),
      "HOME=" + folder.appendingPathComponent("home"),
      "TMPDIR=" + folder.appendingPathComponent("tmp") + "/",
      "LANG=en_US.UTF-8",
      "ARDIA_PLUGIN_NAME=" + name,
      "ARDIA_PLUGIN_FD=\(channelFd)",
      "ARDIA_PLUGIN_PROTOCOL=1",
    ]
    return NetworkEnvironment(variables: base + carried.variables + roots, droppedProxies: carried.droppedProxies)
  }

  static func networkEnvironment(from given: [String: String], network: Bool) -> NetworkEnvironment {
    guard network else { return NetworkEnvironment() }
    var result = NetworkEnvironment()
    for name in proxyEnvironment {
      guard let value = given[name], !value.isEmpty, !value.contains("\0") else { continue }
      if carriesCredentials(value) {
        result.droppedProxies.append(name)
        continue
      }
      result.variables.append("\(name)=\(value)")
    }
    return result
  }

  static func writeAtomically(in directory: Int32, name: String, contents: String) -> Bool {
    let temporary = ".\(name).\(UUID().uuidString)"
    let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o644)
    guard fd >= 0 else { return false }
    let bytes = Array(contents.utf8)
    var written = 0
    while written < bytes.count {
      let step = bytes[written...].withUnsafeBufferPointer { Darwin.write(fd, $0.baseAddress, $0.count) }
      if step <= 0 { break }
      written += step
    }
    let complete = written == bytes.count && fchmod(fd, 0o644) == 0
    Darwin.close(fd)
    guard complete, renameat(directory, temporary, directory, name) == 0 else {
      unlinkat(directory, temporary, 0)
      return false
    }
    return true
  }

  static func profile(network: Bool) -> String {
    let mach = machAllowed + (network ? machAllowedOnline : [])
    let preferences = preferenceDomainsAllowed.isEmpty
      ? "" : "\n(allow user-preference-read \(preferenceDomainsAllowed.map { "(preference-domain \"\($0)\")" }.joined(separator: " ")))"
    let sockets = network
      ? "\n(allow network-outbound \(unixSocketsAllowedOnline.map { "(remote unix-socket (literal \"\($0)\"))" }.joined(separator: " ")))" : ""
    let addresses = network
      ? ""
      : """

        (deny network-outbound (remote ip))
        (deny network-bind (local ip))
        (deny network-inbound (local ip))
        """
    return """
      (version 1)
      (allow default)
      (deny appleevent-send)
      (deny lsopen)
      (deny job-creation)
      (deny distributed-notification-post)
      (deny darwin-notification-post)
      (deny user-preference-write)
      (deny user-preference-read)\(preferences)
      (deny iokit-open)
      (deny sysctl-write)
      (allow sysctl-read)
      (deny process-info* signal)
      (allow process-info* signal (target same-sandbox))
      (allow process-info-listpids)
      (deny ipc-posix-shm*)
      (allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center") (ipc-posix-name-prefix "apple.cfprefs."))
      (deny mach-lookup)
      (allow mach-lookup \(mach.map { "(global-name \"\($0)\")" }.joined(separator: " ")))
      (deny file-read* file-write* (subpath (param "HOME")) (subpath (param "APP_DATA")) (subpath (param "CONFIG")))
      (deny file-read* file-write* \(unreadableTrees.map { "(subpath \"\($0)\")" }.joined(separator: " ")))
      (allow file-read-metadata \(unreadableTrees.map { "(literal \"\($0)\")" }.joined(separator: " ")))
      (deny file-write* (subpath "/"))
      (allow file-write* \(devicesWritable.map { "(literal \"\($0)\")" }.joined(separator: " ")) (subpath "/dev/fd"))
      (deny network-outbound (remote unix-socket))\(sockets)\(addresses)
      (deny network-bind (local unix-socket))
      (allow file-read* (subpath (param "PLUGIN")) (literal (param "PROGRAM")) (subpath (param "INSTALL")))
      (allow file-read* file-write* (subpath (param "DATA")))
      (allow file-read-metadata (literal (param "HOME")))
      """
  }

  enum Refusal: Error {
    case unsafe(String)
  }

  static func resolved(_ path: String) -> String? {
    guard let real = realpath(path, nil) else { return nil }
    defer { free(real) }
    return String(cString: real)
  }

  static func isInside(_ path: String, _ folder: String) -> Bool {
    path == folder || path.hasPrefix(folder.hasSuffix("/") ? folder : folder + "/")
  }

  static func overlaps(_ a: String, _ b: String) -> Bool { isInside(a, b) || isInside(b, a) }

  static func program(_ first: String, pluginFolder: String) -> String? {
    if first.hasPrefix("/") { return resolved(first) }
    if first.contains("/") {
      guard let real = resolved((pluginFolder as NSString).appendingPathComponent(first)), isInside(real, pluginFolder) else { return nil }
      return real
    }
    for dir in searchPath {
      let candidate = (dir as NSString).appendingPathComponent(first)
      if FileManager.default.isExecutableFile(atPath: candidate) { return resolved(candidate) }
    }
    return nil
  }

  private var protected: [String] { [home, appData, configFolder] }

  func installFolder() -> String {
    let parent = (program as NSString).deletingLastPathComponent
    let folder = (parent as NSString).lastPathComponent == "bin" ? (parent as NSString).deletingLastPathComponent : parent
    if folder == "/" || folder.split(separator: "/").count < 2 || protected.contains(where: { Self.overlaps($0, folder) }) { return program }
    if Self.unreadableTrees.contains(where: { Self.overlaps($0, folder) }) && !readable(folder) { return program }
    return folder
  }

  func readable(_ folder: String) -> Bool {
    Self.isInside(folder, pluginFolder)
  }

  static func ancestors(of path: String, below home: String) -> [String] {
    var chain: [String] = []
    var current = (path as NSString).deletingLastPathComponent
    while isInside(current, home) && current != home {
      chain.append(current)
      current = (current as NSString).deletingLastPathComponent
    }
    return chain
  }

  func pathRules() -> (text: String, parameters: [String: String]) {
    var text = ""
    var parameters: [String: String] = [:]
    let roots = [home, appData, configFolder]
    let chain = Set([pluginFolder, program, pluginData].flatMap { path in roots.filter { Self.isInside(path, $0) }.flatMap { Self.ancestors(of: path, below: $0) + [$0] } })
    for (step, folder) in chain.sorted().enumerated() {
      let name = "PATH_UP_\(step)"
      parameters[name] = folder
      text += "\n(allow file-read-metadata (literal (param \"\(name)\")))"
    }
    return (text, parameters)
  }

  func checked() throws {
    for path in [pluginFolder, pluginData, program] where path.isEmpty || path.contains("\0") {
      throw Refusal.unsafe("a path the sandbox can't name")
    }
    let pluginsRoot = (configFolder as NSString).appendingPathComponent("plugins")
    let inPluginsRoot = Self.isInside(pluginFolder, pluginsRoot) && pluginFolder != pluginsRoot
    if pluginFolder == "/" || [home, configFolder, appData].contains(where: { Self.isInside($0, pluginFolder) }) {
      throw Refusal.unsafe("its folder takes in Ardia's data, its settings or your home folder")
    }
    if (Self.isInside(pluginFolder, configFolder) || Self.isInside(pluginFolder, appData)) && !inPluginsRoot {
      throw Refusal.unsafe("its folder is in Ardia's data or config folder")
    }
    if !Self.isInside(program, pluginFolder) && (Self.isInside(program, appData) || Self.isInside(program, configFolder)) {
      throw Refusal.unsafe("its program is in Ardia's data or config folder")
    }
    guard Self.isInside(pluginData, appData), !Self.isInside(appData, pluginData) else { throw Refusal.unsafe("its data folder is in the wrong place") }
  }

  func arguments() throws -> [String] {
    try checked()
    let paths = pathRules()
    let parameters = [
      "HOME": home, "APP_DATA": appData, "CONFIG": configFolder, "PLUGIN": pluginFolder, "DATA": pluginData, "PROGRAM": program,
      "INSTALL": installFolder(),
    ].merging(paths.parameters) { first, _ in first }
    return ["-p", Self.profile(network: network) + paths.text] + parameters.sorted { $0.key < $1.key }.flatMap { ["-D", "\($0.key)=\($0.value)"] }
  }
}
