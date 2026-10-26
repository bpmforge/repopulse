package com.example.reports

import java.io.File
import java.text.SimpleDateFormat

class Reports(private val userRepository: UserRepository) {
    fun owners(ids: List<Long>) {
        for (id in ids) {
            // ruleid: bpm-perf-kt-db-call-in-loop
            val u = userRepository.findById(id)
            u.touch()
        }
        ids.forEach {
            // ruleid: bpm-perf-kt-db-call-in-loop
            userRepository.deleteById(it)
        }
    }

    fun digits(lines: List<String>): Int {
        var n = 0
        for (line in lines) {
            // ruleid: bpm-perf-kt-regex-compile-in-loop
            if (Regex("\\d+").matches(line)) n++
        }
        return n
    }

    fun csv(cells: List<String>): String {
        var out = ""
        for (cell in cells) {
            // ruleid: bpm-perf-kt-string-concat-in-loop
            out += "$cell,"
        }
        return out
    }

    suspend fun settings(path: String): String {
        // ruleid: bpm-perf-kt-blocking-in-suspend
        Thread.sleep(50)
        // ruleid: bpm-perf-kt-blocking-in-suspend
        return File(path).readText()
    }

    fun stamps(times: List<Long>): List<String> {
        val out = mutableListOf<String>()
        for (t in times) {
            // ruleid: bpm-perf-kt-formatter-in-loop
            out.add(SimpleDateFormat("yyyy-MM-dd").format(t))
        }
        return out
    }
}
