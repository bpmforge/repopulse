// Triggering fixture for the injection pack (bpm-baseline.injection.v1.yaml).
// `// ruleid: <id>` names the rule that must fire on the NEXT line.
package main

import (
	"database/sql"
	"encoding/gob"
	"fmt"
	"net/http"
	"os"
	"os/exec"
)

func user(db *sql.DB, w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	// ruleid: bpm-inj-sql-go
	db.Query("SELECT * FROM users WHERE id = '" + id + "'")
	// ruleid: bpm-inj-sql-go
	db.Exec(fmt.Sprintf("DELETE FROM users WHERE name = '%s'", r.FormValue("name")))
}

func ping(w http.ResponseWriter, r *http.Request) {
	host := r.FormValue("host")
	// ruleid: bpm-inj-cmd-go
	exec.Command("sh", "-c", "ping -c 1 "+host).Run()
}

func file(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("file")
	// ruleid: bpm-inj-path-go
	data, err := os.ReadFile("/srv/uploads/" + name)
	if err != nil {
		return
	}
	w.Write(data)
}

func hello(w http.ResponseWriter, r *http.Request) {
	// ruleid: bpm-inj-xss-go
	fmt.Fprintf(w, "<h1>Hello %s</h1>", r.URL.Query().Get("name"))
}

func proxy(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("url")
	// ruleid: bpm-inj-ssrf-go
	resp, _ := http.Get(target)
	defer resp.Body.Close()
}

func redirect(w http.ResponseWriter, r *http.Request) {
	// ruleid: bpm-inj-redirect-go
	http.Redirect(w, r, r.URL.Query().Get("next"), http.StatusFound)
}

func load(w http.ResponseWriter, r *http.Request) {
	var v interface{}
	// ruleid: bpm-inj-deserialize-go
	gob.NewDecoder(r.Body).Decode(&v)
}
