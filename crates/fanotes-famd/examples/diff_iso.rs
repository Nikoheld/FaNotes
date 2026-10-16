fn main() {
    unsafe extern "C" {
        fn tzset();
    }
    unsafe { tzset() };
    let mut input = String::new();
    let stdin = std::io::stdin();
    while stdin.read_line(&mut input).expect("read") > 0 {
        let line = input.trim_end_matches(['\n', '\r']);
        if line.is_empty() {
            input.clear();
            continue;
        }
        let value: String = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("bad json: {error}");
                std::process::exit(1);
            }
        };
        match fanotes_famd::canonical_iso(&value) {
            Some(iso) => println!("{iso}"),
            None => println!("NONE"),
        }
        input.clear();
    }
}
