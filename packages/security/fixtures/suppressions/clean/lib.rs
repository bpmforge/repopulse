// #![allow(warnings)] would silence the whole crate; this file does not.
/* outer /* nested #![allow(unused)] */ still a comment */

#[allow(dead_code)]
fn helper<'a>(s: &'a str) -> &'a str {
    let quote = '"';
    let _text = "#![allow(unused)]";
    let _raw = r#"#![allow(unused)]"#;
    let _ = quote;
    s
}
