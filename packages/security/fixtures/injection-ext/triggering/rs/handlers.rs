// Triggering fixture for bpm-baseline.injection.dotnet-kotlin-rust.v1.yaml.
// `// ruleid: <id>` names the rule that must fire on the NEXT line.
use actix_web::{web, HttpRequest, HttpResponse};
use std::process::Command;

pub async fn find(web::Path(id): web::Path<String>, pool: web::Data<Pool>) -> HttpResponse {
    let q = format!("SELECT * FROM users WHERE id = '{}'", id);
    // ruleid: bpm-inj-sql-rs
    let rows = sqlx::query(&q).fetch_all(&pool).await;
    HttpResponse::Ok().finish()
}

pub async fn ping(req: HttpRequest) -> HttpResponse {
    let host = req.query_string();
    // ruleid: bpm-inj-cmd-rs
    Command::new("sh").arg("-c").arg(format!("ping -c 1 {}", host)).output();
    HttpResponse::Ok().finish()
}

pub async fn read(req: HttpRequest) -> HttpResponse {
    let name = req.match_info().get("file").unwrap();
    // ruleid: bpm-inj-path-rs
    let text = std::fs::read_to_string(name).unwrap();
    HttpResponse::Ok().body(text)
}

pub async fn greet(req: HttpRequest) -> HttpResponse {
    let name = req.query_string();
    let page = format!("<h1>Hello {}</h1>", name);
    // ruleid: bpm-inj-xss-rs
    HttpResponse::Ok().content_type("text/html").body(page)
}

pub async fn fetch(req: HttpRequest) -> HttpResponse {
    let url = req.match_info().get("url").unwrap();
    // ruleid: bpm-inj-ssrf-rs
    let body = reqwest::get(url).await.unwrap().text().await.unwrap();
    HttpResponse::Ok().body(body)
}

pub async fn go(req: HttpRequest) -> HttpResponse {
    let next = req.match_info().get("next").unwrap();
    // ruleid: bpm-inj-redirect-rs
    HttpResponse::Found().append_header(("Location", next)).finish()
}
