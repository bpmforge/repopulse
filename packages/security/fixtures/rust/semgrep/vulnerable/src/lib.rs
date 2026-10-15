// Vulnerable fixture for bpm-baseline.rust.v1 (W18-14): every rule fires here.
use std::process::Command;

use md5;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use sha1::{Digest, Sha1};

pub fn first_byte(buf: &[u8]) -> u8 {
    // bpm-rs-unsafe-without-safety-comment: nothing above says why this holds.
    let len = buf.len();
    let p = buf.as_ptr();
    unsafe { *p.add(len - 1) }
}

pub fn archive(dir: &str) -> std::io::Result<std::process::Output> {
    // bpm-rs-shell-command-format
    Command::new("sh").arg("-c").arg(format!("tar czf out.tgz {}", dir)).output()
}

pub fn grep(pattern: &str) -> std::io::Result<std::process::Output> {
    let cmd = format!("grep -r {} .", pattern);
    Command::new("bash").arg("-c").arg(&cmd).output()
}

pub fn new_session_token() -> String {
    // bpm-rs-predictable-rng-secret
    let mut rng = StdRng::seed_from_u64(42);
    let session_token: u64 = rng.gen();
    format!("{:x}", session_token)
}

pub fn reset_code() -> u32 {
    let otp_code = fastrand::u32(100_000..999_999);
    otp_code
}

pub fn store_password(password: &str) -> String {
    // bpm-rs-weak-hash-password
    let digest = md5::compute(password.as_bytes());
    format!("{:x}", digest)
}

pub fn store_password_sha1(user_password: &str) -> Vec<u8> {
    let mut hasher = Sha1::new();
    hasher.update(user_password.as_bytes());
    hasher.finalize().to_vec()
}

pub fn client() -> reqwest::Client {
    // bpm-rs-tls-verification-disabled
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .expect("client")
}

pub fn frame(payload: &[u8]) -> Vec<u8> {
    // bpm-rs-truncating-len-cast
    let mut out = (payload.len() as u16).to_be_bytes().to_vec();
    out.extend_from_slice(payload);
    out
}
