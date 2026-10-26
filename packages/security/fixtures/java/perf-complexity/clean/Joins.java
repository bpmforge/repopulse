import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

// The same jobs in linear time, and look-alikes that are not quadratic (W21-20).
class Joins {
    record Pr(int id, int repoId) {}

    static int inScope(List<Pr> prs, List<Integer> repoIds) {
        Set<Integer> wanted = new HashSet<>(repoIds);
        int n = 0;
        for (Pr p : prs) {
            if (wanted.contains(p.repoId())) n++;
        }
        return n;
    }

    static int matched(List<Pr> prs, List<Pr> rows) {
        Map<Integer, Pr> byId = rows.stream().collect(Collectors.toMap(Pr::id, Function.identity()));
        int n = 0;
        for (Pr p : prs) {
            if (byId.containsKey(p.id())) n++;
        }
        return n;
    }

    static void drain(ArrayDeque<Integer> queue) {
        while (!queue.isEmpty()) {
            queue.pollFirst();
        }
    }
}
