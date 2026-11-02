import Foundation
import AppKit
import Carbon
import ApplicationServices
func sourceID() -> String {
 let s = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
 guard let p = TISGetInputSourceProperty(s,kTISPropertyInputSourceID) else { return "" }
 return unsafeBitCast(p,to:CFString.self) as String
}
func emit(_ x: Any) { let d = try! JSONSerialization.data(withJSONObject:x,options:[.sortedKeys]); print(String(data:d,encoding:.utf8)!) }
let args = CommandLine.arguments
let mode = args[1]
let target = args.count > 2 ? Int32(args[2]) ?? 0 : 0
func guardFocus() { if NSWorkspace.shared.frontmostApplication?.processIdentifier != target { emit(["blocked":"foreground changed", "target":target]); exit(42) } }
if mode == "state" {
 let p = CGEvent(source:nil)!.location
 emit(["pid":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,"mouse":[p.x,p.y],"inputSource":sourceID(),"os":ProcessInfo.processInfo.operatingSystemVersionString,"ax":AXIsProcessTrusted(),"postAccess":CGPreflightPostEventAccess()])
} else if mode == "keys" {
 guardFocus()
 if !sourceID().contains("SCIM") { emit(["blocked":"not SCIM", "inputSource":sourceID()]); exit(43) }
 let keys: [String:CGKeyCode] = ["n":CGKeyCode(kVK_ANSI_N),"i":CGKeyCode(kVK_ANSI_I),"h":CGKeyCode(kVK_ANSI_H),"a":CGKeyCode(kVK_ANSI_A),"o":CGKeyCode(kVK_ANSI_O),"space":CGKeyCode(kVK_Space),"escape":CGKeyCode(kVK_Escape),"undo":CGKeyCode(kVK_ANSI_Z),"redo":CGKeyCode(kVK_ANSI_Z)]
 for token in args[3].split(separator:",").map(String.init) {
  guard let key = keys[token] else { exit(44) }
  for down in [true,false] {
   guardFocus()
   let e = CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:down)!
   // Do not inherit the preceding synthetic CmdZ flags or physical modifiers.
   e.flags = []
   if token == "undo" { e.flags = .maskCommand }
   if token == "redo" { e.flags = [.maskCommand,.maskShift] }
   e.post(tap:.cghidEventTap)
   usleep(35000)
  }
  usleep(150000)
 }
 emit(["posted":args[3],"inputSource":sourceID(),"pid":target])
} else if mode == "windows" {
 let imePids = Set(NSWorkspace.shared.runningApplications.filter { ($0.bundleIdentifier ?? "").contains("SCIM") || ($0.bundleIdentifier ?? "").contains("inputmethod") }.map { $0.processIdentifier })
 let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
 let safe = list.filter { let p = ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0; return p == target || imePids.contains(p) }
 emit(["windows":safe,"imePids":Array(imePids),"screenCaptureAccess":CGPreflightScreenCaptureAccess()])
} else if mode == "restore" {
 if NSWorkspace.shared.frontmostApplication?.processIdentifier == target {
  if let initial = NSRunningApplication(processIdentifier:Int32(args[3])!) { initial.activate(options:[]) }
  CGWarpMouseCursorPosition(CGPoint(x:Double(args[4])!,y:Double(args[5])!))
  emit(["restored":true])
 } else { emit(["restored":false,"reason":"foreground PID differs; not stealing focus"]) }
}
