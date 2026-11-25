import Darwin
import Foundation
import JavaScriptCore

func hostFail(_ message: String) -> Never {
  HostGlobals.write("[ardia] \(message)")
  exit(1)
}

func entryArgument(_ arguments: [String]) -> String? {
  guard let flag = arguments.firstIndex(of: "--entry"), flag + 1 < arguments.count else { return nil }
  return arguments[flag + 1]
}

signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
terminate.setEventHandler { exit(0) }
terminate.activate()

guard let entry = entryArgument(CommandLine.arguments) else { hostFail("usage: ArdiaPluginHost --entry <path inside the plugin's folder>") }
let channelFd = Int32(ProcessInfo.processInfo.environment["ARDIA_PLUGIN_FD"] ?? "") ?? 3
var channelInfo = stat()
guard fstat(channelFd, &channelInfo) == 0 else { hostFail("ARDIA_PLUGIN_FD \(channelFd) isn't open") }

let source: String
switch HostEntry.read(entry) {
case .success(let text): source = text
case .failure(let failure): hostFail(failure.message)
}

guard let machine = JSVirtualMachine(), let context = JSContext(virtualMachine: machine) else { hostFail("JavaScriptCore couldn't start") }
context.name = "Ardia plugin \(ProcessInfo.processInfo.environment["ARDIA_PLUGIN_NAME"] ?? entry)"
var failedAtStart = false
var evaluatingEntry = false
context.exceptionHandler = { _, exception in
  guard let exception else { return }
  let stack = exception.objectForKeyedSubscript("stack").flatMap { $0.isUndefined ? nil : $0.toString() } ?? ""
  HostGlobals.write("Uncaught \(exception.toString() ?? "exception")\(stack.isEmpty ? "" : "\n" + stack)")
  if evaluatingEntry { failedAtStart = true }
}

let globals = HostGlobals(context: context, queue: .main)
let channel = HostChannel(fd: channelFd, queue: .main, onLine: { line in globals.deliver(line) }, onClose: { exit(0) })
globals.attach(channel)
evaluatingEntry = true
let install = context.evaluateScript(HostPrelude.source, withSourceURL: URL(string: "ardia://plugin-host/prelude.js"))
guard !failedAtStart, let install, install.isObject else { hostFail("the plugin host's prelude didn't load") }
install.call(withArguments: [globals.native()])
guard !failedAtStart else { hostFail("the plugin host's prelude didn't install") }
channel.open()
context.evaluateScript(source, withSourceURL: URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(entry))
evaluatingEntry = false
if failedAtStart { hostFail("\(entry) threw while it loaded, so the plugin stopped") }
dispatchMain()
