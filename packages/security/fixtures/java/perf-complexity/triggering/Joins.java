import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

// Algorithmic shapes (W21-20): linear in one collection per element of another.
class Joins {
    record Pr(int id, int repoId) {}

    static int inScope(List<Pr> prs, List<Integer> repoIds) {
        int n = 0;
        for (Pr p : prs) {
            // ruleid: bpm-perf-java-contains-in-loop
            if (repoIds.contains(p.repoId())) n++;
        }
        return n;
    }

    static int matched(List<Pr> prs, List<Pr> rows) {
        int n = 0;
        for (Pr p : prs) {
            // ruleid: bpm-perf-java-find-by-key-in-loop
            Optional<Pr> r = rows.stream().filter(x -> x.id() == p.id()).findFirst();
            if (r.isPresent()) n++;
        }
        return n;
    }

    static void drain(ArrayList<Integer> queue) {
        while (!queue.isEmpty()) {
            // ruleid: bpm-perf-java-remove-front-in-loop
            queue.remove(0);
        }
    }
}
