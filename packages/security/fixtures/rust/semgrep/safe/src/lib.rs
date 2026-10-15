// Safe fixture for bpm-baseline.rust.v1 (W18-14): the same jobs done safely,
// plus the near-misses each rule must leave alone. Nothing here may fire.
use std::process::Command;

use rand::rngs::{OsRng, SmallRng};
use rand::{Rng, RngCore, SeedableRng};
use sha1::{Digest, Sha1};

pub fn first_byte(buf: &[u8]) -> Option<u8> {
    let len = buf.len();
    let p = buf.as_ptr();
    if len == 0 {
        return None;
    }
    // SAFETY: len > 0 was checked above, so len - 1 is in bounds of `buf`.
    Some(unsafe { *p.add(len - 1) })
}

pub fn second_byte(buf: &[u8]) -> u8 {
    assert!(buf.len() > 1);
    // Safety: the assert above guarantees index 1 exists; the comment may be
    // any prose, as long as someone wrote one.
    let v =
        unsafe { *buf.as_ptr().add(1) };
    v
}

pub fn archive(dir: &str) -> std::io::Result<std::process::Output> {
    // No shell: the directory is one argument, whatever it contains.
    Command::new("tar").arg("czf").arg("out.tgz").arg(dir).output()
}

pub fn fixed_script() -> std::io::Result<std::process::Output> {
    // A constant command line has nothing to inject.
    Command::new("sh").arg("-c").arg("echo ready").output()
}

pub fn new_session_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn thread_rng_token() -> u64 {
    // thread_rng is a CSPRNG; deliberately not flagged (see the pack header).
    let session_token: u64 = rand::thread_rng().gen();
    session_token
}

pub fn shuffle_seed() -> u64 {
    // A seeded generator for a simulation is fine — nothing secret is made.
    let mut rng = SmallRng::seed_from_u64(7);
    let jitter_ms: u64 = rng.gen_range(0..100);
    jitter_ms
}

pub fn cache_key(body: &[u8]) -> Vec<u8> {
    // SHA-1 as a content fingerprint, not a password store.
    let mut hasher = Sha1::new();
    hasher.update(body);
    hasher.finalize().to_vec()
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(false)
        .build()
        .expect("client")
}

pub fn frame(payload: &[u8]) -> Result<Vec<u8>, std::num::TryFromIntError> {
    let len = u16::try_from(payload.len())?;
    let mut out = len.to_be_bytes().to_vec();
    out.extend_from_slice(payload);
    Ok(out)
}

pub fn frame_checked(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    if payload.len() <= u16::MAX as usize {
        out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    }
    out
}

pub fn widths(a: &[u8]) -> (u64, usize) {
    (a.len() as u64, a.len())
}
