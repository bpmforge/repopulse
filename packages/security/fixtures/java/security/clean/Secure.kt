package com.example.secure

import java.security.MessageDigest
import java.security.SecureRandom
import kotlin.random.Random

class Secure(private val jdbcTemplate: JdbcTemplate) {
    fun find(name: String) {
        jdbcTemplate.queryForList("SELECT * FROM users WHERE name = ?", name)
    }

    fun etag(body: ByteArray): ByteArray = MessageDigest.getInstance("MD5").digest(body)

    fun issue(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    fun jitterMillis(): Long {
        val jitter = Random.nextLong(100)
        return jitter
    }
}
