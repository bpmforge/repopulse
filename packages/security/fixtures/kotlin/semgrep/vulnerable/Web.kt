import android.webkit.WebView
import javax.net.ssl.X509TrustManager
import java.security.cert.X509Certificate

class Web {
    fun setup(v: WebView) {
        v.settings.allowUniversalAccessFromFileURLs = true
        v.addJavascriptInterface(Bridge(), "bridge")
    }
}

class TrustAll : X509TrustManager {
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) { }
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { }
    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
}
