package com.example.sync

// Kotlin constructs the anti-slop rules must flag. Each expected finding is
// announced by a `ruleid:` comment on the line above it.
class Sync(private val client: Client) {
    fun push(id: Long) {
        try {
            client.push(id)
            // ruleid: bpm-ch-kt-empty-catch
        } catch (e: IllegalStateException) {
        }
    }

    fun pushLoudly(id: Long) {
        try {
            client.push(id)
            // ruleid: bpm-ch-kt-empty-catch
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    fun fetch(id: Long): Item? =
        try {
            client.fetch(id)
            // ruleid: bpm-ch-kt-silent-fallback
        } catch (e: Exception) {
            null
        }

    fun names(): List<String> {
        try {
            return client.names()
            // ruleid: bpm-ch-kt-silent-fallback
        } catch (t: Throwable) {
            return emptyList()
        }
    }

    // ruleid: bpm-ch-kt-run-catching-swallow
    fun quiet(id: Long): Item? = runCatching { client.fetch(id) }.getOrNull()

    // ruleid: bpm-ch-kt-todo-stub
    fun delete(id: Long): Unit = TODO("delete is not wired yet")

    fun retry() {
        // ruleid: bpm-ch-kt-todo-stub
        TODO()
    }

    fun count(items: List<Item>): Int {
        var n = 0
        // ruleid: bpm-ch-jvm-what-comment
        // iterate over items
        for (i in items) {
            n += 1
        }
        return n
    }
}
