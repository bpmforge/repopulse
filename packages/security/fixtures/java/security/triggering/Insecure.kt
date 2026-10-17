package com.example.insecure

import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.X509TrustManager
import kotlin.random.Random

class Insecure(private val jdbcTemplate: JdbcTemplate) {
    fun find(name: String) {
        // ruleid: bpm-kt-sql-string-concat
        jdbcTemplate.queryForList("SELECT * FROM users WHERE name = '$name'")
        // ruleid: bpm-kt-sql-string-concat
        jdbcTemplate.update("DELETE FROM users WHERE id = " + name)
    }

    fun hashPassword(password: String): ByteArray {
        // ruleid: bpm-kt-weak-hash-secret
        val md = MessageDigest.getInstance("SHA-1")
        return md.digest(password.toByteArray())
    }

    fun issue(): String {
        // ruleid: bpm-kt-insecure-random-token
        val apiToken = Random.nextLong()
        return apiToken.toString(16)
    }

    // The other generators the rule names, in the shapes Kotlin code writes them.
    // The function names say nothing about secrets, so each hit is the VARIABLE name.
    fun viaDefault(): Int {
        // ruleid: bpm-kt-insecure-random-token
        val csrfToken = Random.Default.nextInt()
        return csrfToken
    }

    fun viaQualified(): Long {
        // ruleid: bpm-kt-insecure-random-token
        val resetCode = kotlin.random.Random.nextLong()
        return resetCode
    }

    fun viaJava(): Int {
        // ruleid: bpm-kt-insecure-random-token
        val otpValue = java.util.Random().nextInt(1_000_000)
        return otpValue
    }

    fun viaCollection(alphabet: List<Char>): String {
        // ruleid: bpm-kt-insecure-random-token
        val apiKey = (1..32).map { alphabet.random() }.joinToString("")
        return apiKey
    }

    fun viaRange(): Int {
        // ruleid: bpm-kt-insecure-random-token
        val sessionId = (100000..999999).random()
        return sessionId
    }

    fun viaMath(): Double {
        // ruleid: bpm-kt-insecure-random-token
        val nonce = Math.random()
        return nonce
    }

    // Here it is the FUNCTION name (a generator of session ids), and Math.random()
    // is written fully qualified.
    fun generateSessionId(): String {
        // ruleid: bpm-kt-insecure-random-token
        return java.lang.Math.random().toString()
    }

    val trustAll = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}

        // ruleid: bpm-kt-trust-all-certificates
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}

        override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
    }

    // ruleid: bpm-kt-hostname-verification-disabled
    val anyHost = HostnameVerifier { _, _ -> true }

    fun client(builder: OkHttpClient.Builder) =
        // ruleid: bpm-kt-hostname-verification-disabled
        builder.hostnameVerifier { _, _ -> true }
}
