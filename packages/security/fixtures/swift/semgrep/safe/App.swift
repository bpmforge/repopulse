import Foundation
import CryptoKit
import WebKit

final class Net: NSObject, URLSessionDelegate {
    func open(_ s: String) -> URL? { URL(string: s) }
    func home() -> URL { URL(string: "https://example.com")! }

    func digest(_ d: Data) -> SHA256.Digest { SHA256.hash(data: d) }

    func key() -> SymmetricKey { SymmetricKey(size: .bits256) }

    func show(_ w: WKWebView, name: String) {
        w.callAsyncJavaScript("greet(name)", arguments: ["name": name], in: nil, in: .page, completionHandler: nil)
        w.evaluateJavaScript("refresh()", completionHandler: nil)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        var error: CFError?
        guard let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        if SecTrustEvaluateWithError(trust, &error) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
