package com.example

import org.slf4j.LoggerFactory

class Reporter(private val client: Client) {
    private val log = LoggerFactory.getLogger(Reporter::class.java)

    fun report(apiKey: String, sessionToken: String) {
        // ruleid: bpm-log-kt-stdout-in-prod
        println("reporting")
        // ruleid: bpm-log-kt-secret-field
        log.info("using key $apiKey")
        // ruleid: bpm-log-kt-secret-field
        log.debug("session ${sessionToken}")
        try {
            client.send()
        } catch (e: Exception) {
            // ruleid: bpm-log-kt-print-stack-trace
            e.printStackTrace()
            client.reset()
        }
    }

    fun flush() {
        // ruleid: bpm-log-kt-and-rethrow
        try {
            client.flush()
        } catch (e: IllegalStateException) {
            log.error("flush failed", e)
            throw e
        }
    }
}
