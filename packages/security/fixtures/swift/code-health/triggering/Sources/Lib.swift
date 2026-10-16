import Foundation

func load(_ path: String) -> Data {
    try! Data(contentsOf: URL(fileURLWithPath: path))
}

func cast(_ any: Any) -> Int {
    any as! Int
}

func save(_ d: Data, to url: URL) {
    do {
        try d.write(to: url)
    } catch {
    }
}

func login(user: String, password: String) {
    print("signing in")
    print("password is \(password)")
}
