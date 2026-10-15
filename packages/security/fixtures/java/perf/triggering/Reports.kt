package com.example.reports

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
}
