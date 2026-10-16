import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

fun length(s: String?): Int {
    return s!!.length
}

fun background() {
    GlobalScope.launch { delay(1000) }
}

fun fetch(): Int = runBlocking {
    delay(10)
    1
}

fun login(user: String, password: String) {
    println("signing in")
    println("password is $password")
}
