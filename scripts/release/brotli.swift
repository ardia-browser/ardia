import Compression
import Foundation

let usage = """
  usage: swift scripts/release/brotli.swift (decode|encode) < input > output
  Brotli through Apple's Compression framework, the decoder Ardia unpacks official plugins with (macOS's tar and
  compression_tool have no brotli).
  """

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

let arguments = CommandLine.arguments.dropFirst()
guard arguments.count == 1, let mode = arguments.first, mode == "decode" || mode == "encode" else {
  if arguments.first == "-h" || arguments.first == "--help" {
    print(usage)
    exit(0)
  }
  fail(usage)
}

let operation = mode == "decode" ? COMPRESSION_STREAM_DECODE : COMPRESSION_STREAM_ENCODE
let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
guard compression_stream_init(stream, operation, COMPRESSION_BROTLI) == COMPRESSION_STATUS_OK else { fail("brotli: couldn't start") }
let chunk = 1 << 20
let target = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
let input = FileHandle.standardInput
let output = FileHandle.standardOutput
var finished = false
while !finished {
  let piece = input.readData(ofLength: chunk)
  let last = piece.isEmpty
  piece.withUnsafeBytes { raw in
    stream.pointee.src_ptr = raw.bindMemory(to: UInt8.self).baseAddress ?? UnsafePointer(target)
    stream.pointee.src_size = raw.count
    repeat {
      let before = stream.pointee.src_size
      stream.pointee.dst_ptr = target
      stream.pointee.dst_size = chunk
      let status = compression_stream_process(stream, last ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0)
      guard status != COMPRESSION_STATUS_ERROR else { fail("brotli: the input is damaged") }
      let produced = chunk - stream.pointee.dst_size
      if produced > 0 { output.write(Data(bytes: target, count: produced)) }
      if status == COMPRESSION_STATUS_END {
        finished = true
        guard stream.pointee.src_size == 0 else { fail("brotli: the input has data after its end") }
      } else if produced == 0 && stream.pointee.src_size == before && (before > 0 || last) {
        fail(last ? "brotli: the input ends too soon" : "brotli: the input is damaged")
      }
    } while !finished && (stream.pointee.src_size > 0 || stream.pointee.dst_size == 0)
  }
}
if mode == "decode" && !input.readData(ofLength: 1).isEmpty { fail("brotli: the input has data after its end") }
compression_stream_destroy(stream)
