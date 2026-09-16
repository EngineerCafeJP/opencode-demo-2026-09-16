import CoreGraphics
// 引数: <owner名|"-"> <タイトル部分一致>
let ownerArg = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "-"
let needle = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as! [[String: Any]]
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let name = w[kCGWindowName as String] as? String ?? ""
  if (ownerArg == "-" || owner == ownerArg) && name.contains(needle), let id = w[kCGWindowNumber as String] {
    print(id)
  }
}
