package com.example.reports

private val DIGITS = Regex("\\d+")

class Reports(private val userRepository: UserRepository) {
    fun owners(ids: List<Long>) {
        userRepository.findAllById(ids).forEach { it.touch() }
    }

    fun digits(lines: List<String>): Int {
        var n = 0
        for (line in lines) {
            if (DIGITS.matches(line)) n++
        }
        return n
    }

    fun csv(cells: List<String>): String = buildString {
        var count = 0
        for (cell in cells) {
            append(cell).append(',')
            count += 1
        }
    }
}
