// The same jobs in linear time (W21-20).
data class Pr(val id: Int, val repoId: Int)

fun matched(prs: List<Pr>, rows: List<Pr>): Int {
    val byId = rows.associateBy { it.id }
    var n = 0
    for (p in prs) {
        if (byId[p.id] != null) n++
    }
    return n
}

fun drain(queue: ArrayDeque<Int>) {
    while (queue.isNotEmpty()) {
        queue.removeFirst()
    }
}
