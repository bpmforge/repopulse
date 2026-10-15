package com.example.sync

import kotlin.coroutines.cancellation.CancellationException

class Sync(private val client: Client, private val log: Logger) {
    fun push(id: Long) {
        try {
            client.push(id)
        } catch (ignored: IllegalStateException) {
            // Already pushed; push is idempotent on the server side.
        }
    }

    fun port(raw: String): Int =
        try {
            raw.toInt()
        } catch (e: NumberFormatException) {
            0
        }

    fun fetch(id: Long): Item? =
        try {
            client.fetch(id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log.warn("fetch failed", e)
            null
        }

    fun safe(id: Long): Result<Item> = runCatching { client.fetch(id) }

    fun loud(id: Long): Item? = runCatching { client.fetch(id) }.onFailure { log.warn("x", it) }.getOrThrow()

    // TODO: batch these once the server supports it
    fun all(ids: List<Long>) = ids.map { client.fetch(it) }
}

private val REMOVE_ON_CANCEL = try {
    Class.forName("java.util.concurrent.ScheduledThreadPoolExecutor").getMethod("setRemoveOnCancelPolicy")
} catch (_: Throwable) {
    null
}

fun sleepQuietly(ms: Long) {
    try {
        Thread.sleep(ms)
    } catch (e: InterruptedException) {
        // Shutdown path: the caller re-checks its running flag right after.
    }
}

fun probe(): Any? =
    try {
        Class.forName("com.example.Optional")
    } catch (e: Throwable) {
        // Optional dependency: absent on most classpaths, and that is fine.
        null
    }
