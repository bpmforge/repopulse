print("usage: tool <file>")
let data = try! Data(contentsOf: URL(fileURLWithPath: "/etc/hosts"))
print(data.count)
