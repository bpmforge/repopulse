package app

import (
	"context"
	"crypto/md5"
	"crypto/sha1"
	"crypto/tls"
	"database/sql"
	"encoding/hex"
	"fmt"
	"math/rand"
	"net/http"
	"os/exec"
)

func Client() *http.Client {
	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	return &http.Client{Transport: tr}
}

func Find(ctx context.Context, db *sql.DB, name string) (*sql.Rows, error) {
	return db.QueryContext(ctx, fmt.Sprintf("select * from users where name = '%s'", name))
}

func Delete(db *sql.DB, id string) error {
	q := "delete from users where id = " + id
	_, err := db.Exec(q)
	return err
}

func HashPassword(password string) string {
	sum := md5.Sum([]byte(password))
	return hex.EncodeToString(sum[:])
}

func HashToken(apiToken string) []byte {
	h := sha1.New()
	h.Write([]byte(apiToken))
	return h.Sum(nil)
}

func NewSessionToken() string {
	const letters = "abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, 32)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))]
	}
	return string(b)
}

func Run(ctx context.Context, script string) error {
	return exec.CommandContext(ctx, "sh", "-c", script).Run()
}

func Serve(h http.Handler) error {
	return http.ListenAndServe(":8080", h)
}

func ServeTLS(h http.Handler) error {
	srv := &http.Server{Addr: ":8443", Handler: h}
	return srv.ListenAndServeTLS("cert.pem", "key.pem")
}
