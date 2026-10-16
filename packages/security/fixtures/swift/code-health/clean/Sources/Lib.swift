import Foundation
import os

private let log = Logger(subsystem: "app", category: "lib")

func load(_ path: String) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: path))
}

func cast(_ any: Any) -> Int? {
    any as? Int
}

func save(_ d: Data, to url: URL) {
    do {
        try d.write(to: url)
    } catch {
        log.error("write failed: \(error.localizedDescription)")
    }
}

func login(user: String, password: String) {
    log.info("signing in \(user, privacy: .private)")
}
