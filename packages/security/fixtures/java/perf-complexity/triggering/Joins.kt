// Algorithmic shapes, Kotlin (W21-20).
data class Pr(val id: Int, val repoId: Int)

fun matched(prs: List<Pr>, rows: List<Pr>): Int {
    var n = 0
    for (p in prs) {
        // ruleid: bpm-perf-kt-find-by-key-in-loop
        val r = rows.firstOrNull { it.id == p.id }
        if (r != null) n++
    }
    return n
}

fun drain(queue: MutableList<Int>) {
    while (queue.isNotEmpty()) {
        // ruleid: bpm-perf-kt-remove-front-in-loop
        queue.removeAt(0)
    }
}
