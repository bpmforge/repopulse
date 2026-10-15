fn helper() -> Result<String, std::io::Error> {
    let text = std::fs::read_to_string("fixture.txt").unwrap();
    Ok(text)
}

#[test]
fn round_trip() {
    let text = helper().unwrap();
    println!("{}", text);
    if text.is_empty() {
        panic!("empty");
    }
}
