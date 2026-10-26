package com.example.reports

import java.io.File
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

private val DAY = DateTimeFormatter.ofPattern("yyyy-MM-dd")

// Near-misses: each shape below is the fix, or a cost that does not repeat,
// and no performance rule may fire on it.
class Misfires(private val userRepository: UserRepository) {
    // delay() suspends; file work moved to the IO dispatcher.
    suspend fun settings(path: String): String {
        delay(50)
        return withContext(Dispatchers.IO) { File(path).readText() }
    }

    // Blocking outside a suspend function is not this rule's concern.
    fun settingsSync(path: String): String = File(path).readText()

    // A formatter built once, and one built from loop data.
    fun stamps(times: List<java.time.LocalDate>, patterns: List<String>): List<String> {
        val out = mutableListOf<String>()
        for (t in times) out.add(DAY.format(t))
        for (p in patterns) out.add(DateTimeFormatter.ofPattern(p).toString())
        return out
    }

    // A String declared inside the loop is fresh each time.
    fun labels(users: List<User>): List<String> {
        val out = mutableListOf<String>()
        for (u in users) {
            var name = u.first
            name += " " + u.last
            out.add(name)
        }
        return out
    }

    // Cursor pagination, the query that produces the loop, and one per chunk.
    fun sweep(ids: List<Long>): Int {
        var last: Long? = null
        var n = 0
        while (true) {
            val page = userRepository.findNextPage(last, 100)
            if (page.isEmpty()) return n
            n += page.size
            last = page.last().id
        }
    }

    fun touchAll(ids: List<Long>) {
        for (u in userRepository.findAllById(ids)) {
            u.touch()
        }
        for (batch in ids.chunked(500)) {
            userRepository.deleteAllById(batch)
        }
    }
}
