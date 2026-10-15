package com.example

import org.slf4j.LoggerFactory

class Reporter(private val client: Client) {
    private val log = LoggerFactory.getLogger(Reporter::class.java)

    fun report(apiKey: String, tokenCount: Int) {
        log.info("reporting with {} tokens", tokenCount)
        log.info("key present: ${apiKey.isNotEmpty()}")
        try {
            client.send()
        } catch (e: Exception) {
            log.warn("send failed", e)
            client.reset()
        }
    }

    fun flush() {
        try {
            client.flush()
        } catch (e: IllegalStateException) {
            throw FlushException("flush failed", e)
        }
    }
}

fun main() {
    println("reporter cli")
}
