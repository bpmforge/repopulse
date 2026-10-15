fn main() -> Result<(), String> {
    let n: u32 = std::env::args().nth(1).unwrap().parse().map_err(|_| "nan".to_string())?;
    eprintln!("n = {}", n);
    Ok(())
}
