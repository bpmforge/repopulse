// Triggering fixture for perf.rust.v1 (W18-14): every rule fires here.
use regex::Regex;

pub fn matching_lines(lines: &[String]) -> usize {
    let mut n = 0;
    for line in lines {
        // bpm-perf-rs-regex-compile-in-loop
        let re = Regex::new(r"^\d{4}-\d{2}-\d{2}").unwrap();
        if re.is_match(line) {
            n += 1;
        }
    }
    n
}

pub fn drain_words(queue: &mut Vec<String>) -> usize {
    let mut n = 0;
    while let Some(word) = queue.pop() {
        let re = regex::Regex::new("[aeiou]").unwrap();
        n += re.find_iter(&word).count();
    }
    n
}

pub fn pairs(items: &Vec<String>) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::new();
    for item in items.iter() {
        // bpm-perf-rs-clone-loop-collection
        let others = items.clone();
        out.push((item.clone(), others));
    }
    out
}

pub fn long_names(names: &[String]) -> usize {
    // bpm-perf-rs-collect-then-iterate
    let long = names.iter().filter(|n| n.len() > 10).collect::<Vec<_>>().len();
    let total: usize = names.iter().map(|n| n.len()).collect::<Vec<usize>>().iter().sum();
    long + total
}

pub async fn users(pool: &sqlx::PgPool, ids: &[i64]) -> Vec<User> {
    let mut out = Vec::new();
    for id in ids {
        // bpm-perf-rs-db-call-in-loop
        let u = sqlx::query_as::<_, User>("select * from users where id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap();
        out.push(u);
    }
    out
}

pub async fn config(path: &str) -> String {
    // bpm-perf-rs-blocking-in-async
    std::thread::sleep(std::time::Duration::from_millis(5));
    std::fs::read_to_string(path).unwrap()
}

pub fn drain_front(mut queue: Vec<u32>) -> u32 {
    let mut total = 0;
    while !queue.is_empty() {
        // bpm-perf-rs-remove-front-in-loop
        total += queue.remove(0);
    }
    total
}

pub fn owned_by(orders: &[Order], users: &[User]) -> usize {
    let mut n = 0;
    for o in orders {
        // bpm-perf-rs-find-in-loop
        if users.iter().any(|u| u.id == o.user_id) {
            n += 1;
        }
    }
    n
}
