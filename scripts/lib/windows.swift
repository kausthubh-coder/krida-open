// Prints each window of a process: number, layer, width, height, name. For scripts that picture Krida for Mac
// (screencapture -l takes a window number). Usage: swift scripts/lib/windows.swift <pid>
import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int) == pid {
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  print(w[kCGWindowNumber as String]!, w[kCGWindowLayer as String]!, b["Width"] ?? 0, b["Height"] ?? 0, w[kCGWindowName as String] ?? "")
}
