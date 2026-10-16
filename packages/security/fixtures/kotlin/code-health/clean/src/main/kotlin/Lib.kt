import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("lib")

fun length(s: String?): Int = s?.length ?: 0

fun background(scope: CoroutineScope) {
    scope.launch { delay(1000) }
}

suspend fun fetch(): Int {
    delay(10)
    return 1
}

fun login(user: String, password: String) {
    log.info("signing in {}", user)
}

fun notNull(a: Int?, b: Int) = a != b && a == null
