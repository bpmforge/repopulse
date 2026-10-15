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
