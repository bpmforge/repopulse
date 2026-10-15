// Clean fixture for anti-slop.rust.v1 and logging.rust.v1 (W18-14): the same
// jobs as the triggering file, done in the near-miss forms the rules must NOT
// flag. Nothing in this directory may produce a finding.
use std::fs;
use std::io::Write;
use std::sync::Mutex;

use regex::Regex;

pub struct Config {
    pub path: Option<String>,
    pub api_key: String,
}

#[derive(Debug)]
pub enum LoadError {
    MissingPath,
    Io(std::io::Error),
}

// Errors returned, not unwrapped.
pub fn load(cfg: &Config) -> Result<String, LoadError> {
    let path = cfg.path.as_ref().ok_or(LoadError::MissingPath)?;
    fs::read_to_string(path).map_err(LoadError::Io)
}

// No error channel: an unwrap here is an invariant, out of scope by design.
pub fn first_word(text: &str) -> &str {
    text.split_whitespace().next().unwrap()
}

// Idioms the unwrap rule leaves alone even inside a Result fn.
pub fn idioms(shared: &Mutex<Vec<u8>>) -> Result<usize, String> {
    let guard = shared.lock().unwrap();
    let re = Regex::new("^[a-z]+$").unwrap();
    let limit = "42".parse::<usize>().unwrap();
    let mut line = String::new();
    std::fmt::Write::write_fmt(&mut line, format_args!("{}", guard.len())).map_err(|e| e.to_string())?;
    Ok(if re.is_match(&line) { limit } else { guard.len() })
}

// A parser's own `expect(token)` returns a Result — not a panic.
pub struct Parser;
impl Parser {
    fn expect(&mut self, _c: char) -> Result<(), String> {
        Ok(())
    }
    pub fn pair(&mut self) -> Result<(), String> {
        self.expect(',')?;
        Ok(())
    }
}

pub fn parse_port(text: &str) -> Result<u16, std::num::ParseIntError> {
    text.parse::<u16>()
}

// A panic for an internal invariant, in a function with no error channel.
pub fn checked_index(len: usize, i: usize) -> usize {
    if i >= len {
        panic!("index {} out of bounds for length {}", i, len);
    }
    i
}

// Compile-time assertion: fails the build, never a caller.
const _: () = if usize::BITS < 32 { panic!("needs a 32-bit target") };

// The Err arm does something.
pub fn remove_cache(path: &str) {
    match fs::remove_file(path) {
        Ok(()) => log::debug!("removed {}", path),
        Err(e) => log::warn!("could not remove {}: {}", path, e),
    }
}

// The Ok arm is the empty one — nothing is being swallowed.
pub fn touch(path: &str) -> Result<(), std::io::Error> {
    match fs::metadata(path) {
        Ok(_) => {}
        Err(e) => return Err(e),
    }
    Ok(())
}

// Write results propagated; a discarded channel send is idiomatic.
pub fn save(out: &mut fs::File, body: &[u8], tx: &std::sync::mpsc::Sender<u8>) -> std::io::Result<()> {
    out.write_all(body)?;
    out.flush()?;
    let _ = tx.send(1);
    Ok(())
}

pub fn bump(counter: &mut u64) {
    // Saturating: a wrapped counter would read as a reset to the dashboard.
    *counter = counter.saturating_add(1);
}

/// Increment the counter. (A doc comment describes an interface.)
pub fn bump_doc(counter: &mut u64) {
    *counter += 1;
}

pub fn wait(ready: &mut bool) {
    // The scheduler parks here until the waker fires, and on wake it must
    // return quickly.
    *ready = true;
}

// Logging with secrets out of the record; secret words only in prose.
pub fn login(user: &str, password: &str, cfg: &Config) {
    log::info!("password reset sent to {}", user);
    tracing::debug!(user = %user, "password changed");
    tracing::info!(key_len = cfg.api_key.len(), "calling upstream");
    let _ = password;
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn loads() {
        let cfg = Config { path: None, api_key: String::new() };
        let text = load(&cfg).map(|_| ()).unwrap_err();
        println!("{:?}", text);
        dbg!(cfg.api_key.len());
    }
}
