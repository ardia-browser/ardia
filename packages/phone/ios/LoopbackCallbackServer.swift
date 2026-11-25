import ArdiaBrowser
import Darwin
import Foundation

nonisolated final class LoopbackCallbackServer: @unchecked Sendable {
  static let maximumRequestBytes = 16 * 1024
  static let maximumClients = 8
  static let clientDeadline: DispatchTimeInterval = .seconds(10)

  enum StartFailure: Error {
    case socket(Int32)
  }

  private let queue = DispatchQueue(label: "com.ardia.browser.ios.chatgpt.loopback")
  private let listenSocket: Int32
  private let acceptSource: DispatchSourceRead
  private var clients: [Int32: (source: DispatchSourceRead, buffer: Data)] = [:]
  private var expectedState = ""
  private var savedClientID: String?
  private var outcome: LoopbackRequest.Outcome?
  let port: UInt16

  private init(socket: Int32, port: UInt16) {
    listenSocket = socket
    self.port = port
    acceptSource = DispatchSource.makeReadSource(fileDescriptor: socket, queue: queue)
    acceptSource.setEventHandler { [weak self] in self?.acceptClients() }
    acceptSource.setCancelHandler { Darwin.close(socket) }
    acceptSource.resume()
  }

  static func start() throws -> LoopbackCallbackServer {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw StartFailure.socket(errno) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) } }
    guard bound == 0, listen(fd, 8) == 0,
          withUnsafeMutablePointer(to: &address, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }) == 0,
          fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) == 0 else {
      let code = errno
      Darwin.close(fd)
      throw StartFailure.socket(code)
    }
    return LoopbackCallbackServer(socket: fd, port: UInt16(bigEndian: address.sin_port))
  }

  func expect(state: String, savedClientID: String?) {
    queue.sync {
      expectedState = state
      self.savedClientID = savedClientID
    }
  }

  var receivedOutcome: LoopbackRequest.Outcome? {
    queue.sync { outcome }
  }

  func stop() {
    queue.sync {
      for fd in Array(clients.keys) { closeClient(fd) }
      acceptSource.cancel()
    }
  }

  private func acceptClients() {
    while true {
      let client = accept(listenSocket, nil, nil)
      guard client >= 0 else { return }
      guard clients.count < Self.maximumClients else {
        Darwin.close(client)
        continue
      }
      var noSignal: Int32 = 1
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
      _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) | O_NONBLOCK)
      let source = DispatchSource.makeReadSource(fileDescriptor: client, queue: queue)
      source.setEventHandler { [weak self] in self?.read(client) }
      source.setCancelHandler { Darwin.close(client) }
      clients[client] = (source, Data())
      source.resume()
      queue.asyncAfter(deadline: .now() + Self.clientDeadline) { [weak self] in
        guard let self, let entry = self.clients[client], (entry.source as AnyObject) === (source as AnyObject) else { return }
        self.closeClient(client)
      }
    }
  }

  private func read(_ client: Int32) {
    guard var entry = clients[client] else { return }
    var chunk = [UInt8](repeating: 0, count: 4096)
    let count = recv(client, &chunk, chunk.count, 0)
    if count < 0, errno == EAGAIN || errno == EWOULDBLOCK { return }
    guard count > 0 else { return closeClient(client) }
    entry.buffer.append(contentsOf: chunk[0..<count])
    clients[client] = entry
    if let end = entry.buffer.range(of: Data("\r\n\r\n".utf8)) {
      answer(client, head: String(decoding: entry.buffer[..<end.lowerBound], as: UTF8.self))
    } else if entry.buffer.count >= Self.maximumRequestBytes {
      closeClient(client)
    }
  }

  private func answer(_ client: Int32, head: String) {
    var reply = LoopbackRequest.evaluate(head, port: port, state: expectedState, savedClientID: savedClientID)
    if case .finish(let result) = reply {
      if outcome == nil { outcome = result } else { reply = .notFound }
    }
    let response = LoopbackRequest.response(for: reply)
    _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) & ~O_NONBLOCK)
    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    response.withUnsafeBytes { bytes in
      var sent = 0
      while sent < bytes.count {
        let written = send(client, bytes.baseAddress! + sent, bytes.count - sent, 0)
        guard written > 0 else { break }
        sent += written
      }
    }
    shutdown(client, SHUT_WR)
    closeClient(client)
  }

  private func closeClient(_ client: Int32) {
    guard let entry = clients.removeValue(forKey: client) else { return }
    entry.source.cancel()
  }
}
