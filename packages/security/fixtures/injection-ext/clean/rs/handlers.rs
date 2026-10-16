// Clean near-misses: nothing here may fire.
use actix_web::{web, HttpRequest, HttpResponse};
use std::process::Command;

pub async fn find(web::Path(id): web::Path<String>, pool: web::Data<Pool>) -> HttpResponse {
    let n: i64 = id.parse::<i64>().unwrap();
    let q = format!("SELECT * FROM users WHERE id = {}", n);
    let rows = sqlx::query(&q).fetch_all(&pool).await;
    let safe = sqlx::query("SELECT * FROM users WHERE name = $1").bind(id).fetch_all(&pool).await;
    HttpResponse::Ok().finish()
}

pub async fn ping(req: HttpRequest) -> HttpResponse {
    Command::new("ping").arg("-c").arg("1").arg("localhost").output();
    HttpResponse::Ok().finish()
}

pub async fn read(req: HttpRequest) -> HttpResponse {
    let text = std::fs::read_to_string("/srv/data/report.txt").unwrap();
    HttpResponse::Ok().body(text)
}

pub async fn greet(req: HttpRequest) -> HttpResponse {
    let name = html_escape::encode_text(req.query_string());
    let page = format!("<h1>Hello {}</h1>", name);
    HttpResponse::Ok().content_type("text/html").body(page)
}

pub async fn fetch(req: HttpRequest) -> HttpResponse {
    let body = reqwest::get("https://api.example.com/status").await.unwrap().text().await.unwrap();
    HttpResponse::Ok().body(body)
}

pub async fn go(req: HttpRequest) -> HttpResponse {
    HttpResponse::Found().append_header(("Location", "/home")).finish()
}
