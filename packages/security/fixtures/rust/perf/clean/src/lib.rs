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
