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
