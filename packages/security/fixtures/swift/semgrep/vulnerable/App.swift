import Foundation
import CryptoKit
import WebKit

final class Net: NSObject, URLSessionDelegate {
    func open(_ s: String) -> URL { URL(string: s)! }

    func digest(_ d: Data) -> Insecure.MD5.Digest { Insecure.MD5.hash(data: d) }

    func key() -> SymmetricKey { SymmetricKey(data: Data("hunter2hunter2hunter2".utf8)) }

    func show(_ w: WKWebView, name: String) {
        w.evaluateJavaScript("greet('\(name)')", completionHandler: nil)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(.useCredential, URLCredential(trust: challenge.protectionSpace.serverTrust!))
    }
}
