import kotlinx.coroutines.runBlocking

class LibTest {
    fun fetches() = runBlocking {
        val n = length("x")!!
        println("password is $n")
    }
}
