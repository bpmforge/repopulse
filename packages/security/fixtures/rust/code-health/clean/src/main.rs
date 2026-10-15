// A binary owns its process: exiting with a message at the entry point is the
// accepted idiom, so main.rs is excluded from the library rules.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tool <path>");
    let text = std::fs::read_to_string(&path).unwrap();
    println!("{}", text.len());
    Ok(())
}
