// println! is Cargo's build-script protocol, and a panic is the build error.
fn main() -> Result<(), std::io::Error> {
    let out = std::env::var("OUT_DIR").unwrap();
    println!("cargo:rerun-if-changed=build.rs");
    std::fs::write(format!("{}/gen.rs", out), "").expect("write generated file");
    Ok(())
}
