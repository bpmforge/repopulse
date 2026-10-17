package com.example.secure

import java.security.MessageDigest
import java.security.SecureRandom
import kotlin.random.Random
import kotlin.random.asKotlinRandom

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

    // Not secrets: jitter, sampling and shard choice are ordinary uses of the
    // default generator, and nothing here is named like a secret.
    fun shard(shards: Int): Int {
        val shard = (0 until shards).random()
        return shard
    }

    fun greeting(names: List<String>): String {
        val pick = names.random()
        return "hello $pick"
    }

    fun delayMillis(): Long = (Math.random() * 250).toLong()

    // A secret from a cryptographic generator: the `.random(rng)` overload takes the
    // Random it draws from, which is how a SecureRandom is supplied.
    fun sessionToken(alphabet: List<Char>): String {
        val sessionToken = (1..32).map { alphabet.random(SecureRandom().asKotlinRandom()) }.joinToString("")
        return sessionToken
    }

    fun csrfToken(): Long {
        val csrfToken = SecureRandom().nextLong()
        return csrfToken
    }
}
