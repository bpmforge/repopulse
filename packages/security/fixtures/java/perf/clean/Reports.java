package com.example.reports;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

// Near-misses: the same jobs done in one round trip, with a hoisted pattern,
// and a builder.
public class Reports {
    private static final Pattern EMAIL = Pattern.compile("[a-z]+@[a-z]+\\.com");
    private final UserRepository userRepository;

    public Reports(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    public void owners(List<Long> ids, Map<Long, User> cache) {
        List<User> users = userRepository.findAllById(ids);
        for (User u : users) {
            u.touch();
            cache.get(u.id());
        }
    }

    public void insert(Connection conn, List<String> rows) throws Exception {
        try (PreparedStatement ps = conn.prepareStatement("insert into t values (?)")) {
            for (String row : rows) {
                ps.setString(1, row);
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    public void read(ResultSet rs, List<String> out) throws Exception {
        while (rs.next()) {
            out.add(rs.getString(1));
        }
    }

    public int emails(List<String> lines, List<String> patterns) {
        int n = 0;
        for (String line : lines) {
            if (EMAIL.matcher(line).find()) n++;
        }
        for (String w : patterns) {
            // Built from the loop variable around literals: still not hoistable.
            if (Pattern.compile(".*\\b" + w + "\\b.*").matcher("x").find()) n++;
            // Not java.lang.String#matches: a tokenizer's own method.
            if (tokens(w).matches("[")) n++;
        }
        for (String p : patterns) {
            // Built from the loop variable: cannot be hoisted.
            if (Pattern.compile(p).matcher("x").find()) n++;
        }
        return n;
    }

    private Tokens tokens(String s) {
        return new Tokens(s);
    }

    public String csv(List<String> cells) {
        StringBuilder out = new StringBuilder();
        int total = 0;
        for (String cell : cells) {
            out.append(cell).append(',');
            total += cell.length();
        }
        return out.toString() + total;
    }
}
