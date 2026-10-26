// Clean fixture for perf.swift.v1: the fixes and the near-misses. Nothing fires.
import CoreData
import Foundation

private let email = try! NSRegularExpression(pattern: "[a-z]+@[a-z]+\\.com")
private let day: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    return f
}()

final class Reports {
    let context: NSManagedObjectContext

    init(context: NSManagedObjectContext) { self.context = context }

    // A regex hoisted to a static, and one built from loop data.
    func emails(_ lines: [String], _ patterns: [String]) throws -> Int {
        var n = 0
        for line in lines {
            n += email.numberOfMatches(in: line, range: NSRange(line.startIndex..., in: line))
        }
        for p in patterns {
            n += try NSRegularExpression(pattern: p).numberOfCaptureGroups
        }
        return n
    }

    // One formatter for the whole loop.
    func days(_ dates: [Date]) -> [String] {
        var out: [String] = []
        for date in dates {
            out.append(day.string(from: date))
        }
        return out
    }

    // One fetch for the whole set; a network `fetch` is not Core Data.
    func owners(_ ids: [String], api: API) throws -> [Owner] {
        let request = NSFetchRequest<Owner>(entityName: "Owner")
        request.predicate = NSPredicate(format: "id IN %@", ids)
        for id in ids {
            api.fetch(id)
        }
        return try context.fetch(request)
    }

    // Iterating does not shift anything.
    func drain(_ queue: [Int]) -> Int {
        var total = 0
        for x in queue {
            total += x
        }
        return total
    }

    // An index built once, and a search of a literal list of constants.
    func owned(_ orders: [Order], _ users: [User]) -> Int {
        let ids = Set(users.map(\.id))
        var n = 0
        for order in orders {
            if ids.contains(order.userId) && ["paid", "shipped"].contains(where: { $0 == order.state }) {
                n += 1
            }
        }
        return n
    }
}

// Shapes from the 2026-10-26 measurement on public Swift code.
extension Reports {
    // The fetch in the loop HEADER runs once.
    func timestamps() throws -> [Date] {
        let request = NSFetchRequest<NSDictionary>(entityName: "PageView")
        var out: [Date] = []
        for row in try context.fetch(request) {
            if let date = row["timestamp"] as? Date { out.append(date) }
        }
        return out
    }

    // Trimming a prefix, and finding a character in a String.
    func normalized(_ path: String, _ lines: [String]) -> Int {
        var trimmed = path
        while trimmed.hasPrefix("/") {
            trimmed.removeFirst()
        }
        var n = trimmed.count
        for line in lines {
            if line.firstIndex(of: ":") != nil { n += 1 }
        }
        return n
    }
}
