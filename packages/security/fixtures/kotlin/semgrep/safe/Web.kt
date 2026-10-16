import android.webkit.WebView
import javax.net.ssl.X509TrustManager
import java.security.cert.X509Certificate

class Web {
    fun setup(v: WebView) {
        v.settings.allowUniversalAccessFromFileURLs = false
        v.settings.javaScriptEnabled = true
    }
}

class Pinned(private val delegate: X509TrustManager) : X509TrustManager {
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        delegate.checkServerTrusted(chain, authType)
    }
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { }
    override fun getAcceptedIssuers(): Array<X509Certificate> = delegate.acceptedIssuers
}
