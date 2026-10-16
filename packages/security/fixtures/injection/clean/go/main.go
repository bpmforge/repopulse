// Clean near-misses: the same sources and sinks, handled safely.
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

func user(db *sql.DB, w http.ResponseWriter, r *http.Request) {
	db.Query("SELECT * FROM users WHERE id = $1", r.URL.Query().Get("id"))
	n, err := strconv.Atoi(r.URL.Query().Get("n"))
	if err != nil {
		return
	}
	db.Query(fmt.Sprintf("SELECT * FROM users WHERE n = %d", n))
}

func ping(w http.ResponseWriter, r *http.Request) {
	exec.Command("ping", "-c", "1", "localhost").Run()
}

func file(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(r.URL.Query().Get("file"))
	data, err := os.ReadFile(filepath.Join("/srv/uploads", name))
	if err != nil {
		return
	}
	w.Write(data)
}

func hello(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, "<h1>Hello %s</h1>", html.EscapeString(r.URL.Query().Get("name")))
}

func redirect(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/dashboard", http.StatusFound)
}

func load(w http.ResponseWriter, r *http.Request) {
	var v struct{ Name string }
	json.NewDecoder(r.Body).Decode(&v)
}
