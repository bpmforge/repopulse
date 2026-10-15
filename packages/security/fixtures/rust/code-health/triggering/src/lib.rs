// Triggering fixture for anti-slop.rust.v1 and logging.rust.v1 (W18-14).
// Every rule in both packs must fire at least once in this file.
use std::fs;
use std::io::Write;

pub struct Config {
    pub path: Option<String>,
    pub api_key: String,
}

pub struct Session;

// bpm-ch-rs-unwrap-in-lib: the function returns a Result and panics anyway.
pub fn load(cfg: &Config) -> Result<String, std::io::Error> {
    let path = cfg.path.as_ref().unwrap();
    let text = fs::read_to_string(path).expect("config must exist");
    Ok(text)
}

// bpm-ch-rs-stub-as-feature
pub fn export_csv(_rows: &[String]) -> String {
    todo!()
}

pub fn import_csv(_text: &str) -> Vec<String> {
    unimplemented!("csv import")
}

// bpm-ch-rs-panic-in-lib: an Err turned into an abort on the spot.
pub fn parse_port(text: &str) -> u16 {
    match text.parse::<u16>() {
        Ok(port) => port,
        Err(e) => panic!("bad port {}: {}", text, e),
    }
}

pub fn open_session(token: &str) -> Result<Session, String> {
    if token.is_empty() {
        panic!("empty token");
    }
    Ok(Session)
}

// bpm-ch-rs-swallowed-err
pub fn remove_cache(path: &str) {
    match fs::remove_file(path) {
        Ok(()) => println!("removed {}", path),
        Err(_) => {}
    }
}

// bpm-ch-rs-discarded-write
pub fn save(out: &mut fs::File, body: &[u8]) {
    let _ = out.write_all(body);
    out.flush().ok();
}

pub fn bump(counter: &mut u64) {
    // increment the counter
    *counter += 1;
}

// bpm-log-rs-dbg-macro
pub fn total(items: &[u64]) -> u64 {
    dbg!(items.iter().sum())
}

// bpm-log-rs-secret-field: positional, structured field, and inline capture.
pub fn login(user: &str, password: &str, cfg: &Config) {
    log::info!("login attempt for {} with {}", user, password);
    tracing::debug!(api_key = %cfg.api_key, "calling upstream");
    tracing::warn!("retrying with {password}");
}
