// Clean fixture for perf.rust.v1 (W18-14): the same jobs, hoisted and lazy.
use regex::Regex;

pub fn matching_lines(lines: &[String]) -> usize {
    let re = Regex::new(r"^\d{4}-\d{2}-\d{2}").unwrap();
    lines.iter().filter(|line| re.is_match(line)).count()
}

// The pattern comes from the data: it has to be compiled per item.
pub fn user_patterns(patterns: &[String], text: &str) -> usize {
    let mut n = 0;
    for p in patterns {
        if let Ok(re) = Regex::new(p) {
            n += re.find_iter(text).count();
        }
    }
    n
}

pub fn pairs(items: &[String]) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    for item in items.iter() {
        // Cloning the ELEMENT for an owned value is not the rule's concern.
        out.push((item.clone(), items.len()));
    }
    out
}

pub fn long_names(names: &[String]) -> usize {
    let long = names.iter().filter(|n| n.len() > 10).count();
    let total: usize = names.iter().map(|n| n.len()).sum();
    long + total
}

// Collect to end the borrow of `map` before mutating it — correct and needed.
pub fn prune(map: &mut std::collections::HashMap<String, u32>) {
    for key in map.keys().cloned().collect::<Vec<_>>().into_iter() {
        if key.is_empty() {
            map.remove(&key);
        }
    }
}

// One query for the whole set, and one per chunk, are the fix.
pub async fn users(pool: &sqlx::PgPool, ids: &[i64]) -> Vec<User> {
    let mut out = sqlx::query_as::<_, User>("select * from users where id = any($1)")
        .bind(ids)
        .fetch_all(pool)
        .await
        .unwrap();
    for chunk in ids.chunks(500) {
        let more = sqlx::query_as::<_, User>("select * from users where id = any($1)")
            .bind(chunk)
            .fetch_all(pool)
            .await
            .unwrap();
        out.extend(more);
    }
    out
}

// Cursor pagination: each pass fetches the page after the last one.
pub async fn every_user(pool: &sqlx::PgPool) -> usize {
    let mut last = 0i64;
    let mut n = 0;
    loop {
        let page = sqlx::query_as::<_, User>("select * from users where id > $1 limit 100")
            .bind(last)
            .fetch_all(pool)
            .await
            .unwrap();
        let Some(tail) = page.last() else { break };
        last = tail.id;
        n += page.len();
    }
    n
}

// The async file API, and blocking work moved off the executor.
pub async fn config(path: String) -> String {
    let a = tokio::fs::read_to_string(&path).await.unwrap();
    let b = tokio::task::spawn_blocking(move || std::fs::read_to_string(path).unwrap())
        .await
        .unwrap();
    a + &b
}

// Blocking is fine outside async code.
pub fn config_sync(path: &str) -> String {
    std::fs::read_to_string(path).unwrap()
}

// A VecDeque pops from the front cheaply.
pub fn drain_front(mut queue: std::collections::VecDeque<u32>) -> u32 {
    let mut total = 0;
    while let Some(x) = queue.pop_front() {
        total += x;
    }
    total
}

// An index built once, and a search of a literal list of constants.
pub fn owned_by(orders: &[Order], users: &[User]) -> usize {
    let ids: std::collections::HashSet<i64> = users.iter().map(|u| u.id).collect();
    let mut n = 0;
    for o in orders {
        if ids.contains(&o.user_id) && ["paid", "shipped"].iter().any(|s| *s == o.kind) {
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn reads_the_fixture() {
        let text = std::fs::read_to_string("fixtures/a.txt").unwrap();
        assert!(!text.is_empty());
    }
}

// Shapes from the 2026-10-26 measurement on public Rust code.

// A retry with literal bounds, and a literal list of statements.
pub async fn checkpoint(pool: &sqlx::SqlitePool) -> i64 {
    for sql in ["pragma optimize", "pragma wal_checkpoint(truncate)"] {
        let _ = sqlx::query_scalar::<_, i64>(sql).fetch_optional(pool).await;
    }
    for _attempt in 0..10 {
        let busy: i64 = sqlx::query_scalar("pragma wal_checkpoint(truncate)")
            .fetch_one(pool)
            .await
            .unwrap();
        if busy == 0 {
            return 0;
        }
    }
    1
}

// A collection that belongs to the loop's own item is not a join.
pub fn summaries(rows: &[Row]) -> usize {
    let mut n = 0;
    for row in rows {
        if row.content.iter().any(|c| c.is_summary()) {
            n += 1;
        }
    }
    n
}

// A short Vec built fresh each pass.
pub fn lines(rows: &[Row]) -> Vec<Vec<u32>> {
    let mut out = Vec::new();
    for row in rows {
        let mut line = vec![row.id];
        line.insert(0, row.parent);
        out.push(line);
    }
    out
}

#[cfg(test)]
mod pipeline_tests {
    #[test]
    fn compiles_per_case() {
        for case in ["a", "b"] {
            let re = regex::Regex::new("^[a-z]$").unwrap();
            assert!(re.is_match(case));
        }
    }
}
