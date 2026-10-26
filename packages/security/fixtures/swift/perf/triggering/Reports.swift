// Triggering fixture for perf.swift.v1: every rule fires here.
import CoreData
import Foundation

final class Reports {
    let context: NSManagedObjectContext

    init(context: NSManagedObjectContext) { self.context = context }

    func emails(_ lines: [String]) throws -> Int {
        var n = 0
        for line in lines {
            // bpm-perf-sw-regex-in-loop
            let re = try NSRegularExpression(pattern: "[a-z]+@[a-z]+\\.com")
            n += re.numberOfMatches(in: line, range: NSRange(line.startIndex..., in: line))
        }
        return n
    }

    func days(_ dates: [Date]) -> [String] {
        var out: [String] = []
        for date in dates {
            // bpm-perf-sw-formatter-in-loop
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            out.append(f.string(from: date))
        }
        return out
    }

    func owners(_ ids: [String]) throws -> [Owner] {
        var out: [Owner] = []
        for id in ids {
            let request = NSFetchRequest<Owner>(entityName: "Owner")
            request.predicate = NSPredicate(format: "id == %@", id)
            // bpm-perf-sw-fetch-in-loop
            out += try context.fetch(request)
        }
        return out
    }

    func drain(_ queue: inout [Int]) -> Int {
        var total = 0
        while !queue.isEmpty {
            // bpm-perf-sw-remove-front-in-loop
            total += queue.removeFirst()
        }
        return total
    }

    func owned(_ orders: [Order], _ users: [User]) -> Int {
        var n = 0
        for order in orders {
            // bpm-perf-sw-find-in-loop
            if users.contains(where: { $0.id == order.userId }) { n += 1 }
        }
        return n
    }
}
