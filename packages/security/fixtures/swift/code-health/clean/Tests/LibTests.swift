import XCTest

final class LibTests: XCTestCase {
    func testLoad() {
        let d = try! Data(contentsOf: URL(fileURLWithPath: "/etc/hosts"))
        print("bytes \(d.count)")
        let n = (1 as Any) as! Int
        XCTAssertEqual(n, 1)
    }
}
