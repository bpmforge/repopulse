package app

import (
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

func Client() *http.Client {
	tr := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	return &http.Client{Transport: tr}
}

func Find(ctx context.Context, db *sql.DB, name string) (*sql.Rows, error) {
	return db.QueryContext(ctx, "select * from users where name = $1", name)
}

func FindMany(db *sql.DB, ids []any) (*sql.Rows, error) {
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	q := fmt.Sprintf("select * from users where id in (%s)", strings.Join(strings.Split(ph, ","), ","))
	return db.Query(q, ids...)
}

func Page(db *sql.DB, limit int) (*sql.Rows, error) {
	return db.Query(fmt.Sprintf("select * from users limit %d", limit))
}

func Checksum(r io.Reader) (string, error) {
	h := md5.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func CacheKey(path string) string {
	sum := md5.Sum([]byte(path))
	return hex.EncodeToString(sum[:])
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func NewSessionToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func Run(ctx context.Context, dir string) error {
	if err := exec.CommandContext(ctx, "sh", "-c", "make clean").Run(); err != nil {
		return err
	}
	return exec.CommandContext(ctx, "git", "-C", dir, "status").Run()
}

func Serve(h http.Handler) error {
	srv := &http.Server{Addr: ":8080", Handler: h, ReadHeaderTimeout: 5 * time.Second}
	return srv.ListenAndServe()
}

func ServeTLS(h http.Handler) error {
	srv := &http.Server{Addr: ":8443", Handler: h}
	srv.ReadHeaderTimeout = 10 * time.Second
	return srv.ListenAndServeTLS("cert.pem", "key.pem")
}

func DeleteMany(db *sql.DB, ids []any) error {
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	_, err := db.Exec("delete from users where id in ("+strings.Join(strings.Split(ph, ","), ",")+")", ids...)
	return err
}
