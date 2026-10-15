fn run() -> Result<(), String> {
    let v: Vec<u8> = std::fs::read("demo.bin").unwrap();
    println!("{} bytes", v.len());
    todo!()
}

fn main() {
    run().unwrap();
}
