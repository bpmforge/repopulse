package com.example.reports;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.List;
import java.util.regex.Pattern;
import javax.persistence.EntityManager;

// Per-item work the Java perf rules must flag; each expected finding is
// announced on the line above it.
public class Reports {
    private final UserRepository userRepository;
    private final EntityManager em;

    public Reports(UserRepository userRepository, EntityManager em) {
        this.userRepository = userRepository;
        this.em = em;
    }

    public void owners(List<Long> ids) {
        for (Long id : ids) {
            // ruleid: bpm-perf-java-db-call-in-loop
            User u = userRepository.findById(id).orElseThrow();
            u.touch();
        }
    }

    public void totals(List<String> names) {
        names.forEach(n -> {
            // ruleid: bpm-perf-java-db-call-in-loop
            em.createQuery("select o from Order o where o.owner = :n").setParameter("n", n).getResultList();
        });
    }

    public void insert(Connection conn, List<String> rows) throws Exception {
        int i = 0;
        while (i < rows.size()) {
            // ruleid: bpm-perf-java-db-call-in-loop
            PreparedStatement ps = conn.prepareStatement("insert into t values (?)");
            ps.setString(1, rows.get(i++));
            // ruleid: bpm-perf-java-db-call-in-loop
            ps.executeUpdate();
        }
    }

    public int emails(List<String> lines) {
        int n = 0;
        for (String line : lines) {
            // ruleid: bpm-perf-java-regex-compile-in-loop
            if (Pattern.compile("[a-z]+@[a-z]+\\.com").matcher(line).find()) n++;
            // ruleid: bpm-perf-java-regex-compile-in-loop
            line = line.replaceAll("\\s+", " ");
        }
        return n;
    }

    public String csv(List<String> cells) {
        String out = "";
        for (String cell : cells) {
            // ruleid: bpm-perf-java-string-concat-in-loop
            out += cell + ",";
        }
        return out;
    }
}
