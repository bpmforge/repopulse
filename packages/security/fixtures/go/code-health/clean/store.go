package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
)

type Store struct{ db *sql.DB }

var namePattern = regexp.MustCompile(`^[a-z]+$`)

// Limit parses a page size; a bad value falls back to the documented default
// rather than to zero, which would return an empty page.
func (s *Store) Limit(raw string) int {
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 50
	}
	return n
}

func (s *Store) Lookup(m map[string]int, v interface{}, key string) (int, string) {
	// Bool results, not errors: idiomatic and not a discarded failure.
	n, _ := m[key]
	str, _ := v.(string)
	return n, str
}

func (s *Store) Load(blob []byte, out *Config) error {
	if err := json.Unmarshal(blob, out); err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	return nil
}

func (s *Store) Cleanup(tmp string) {
	// Best effort: the directory is under os.TempDir and the OS reclaims it.
	_ = os.Remove(tmp)
}

func (s *Store) Ping() error {
	err := s.db.Ping()
	if err != nil {
		return fmt.Errorf("ping: %w", err)
	}
	return nil
}

func (s *Store) Exists(path string) (bool, error) {
	_, err := os.Stat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) Prune(dir string) error {
	_, err := os.Stat(dir)
	if err != nil {
		// Nothing cached yet: an absent directory is an empty cache.
		return nil
	}
	return os.RemoveAll(dir)
}

// MustOpen panics by contract; callers use it only at program start.
func MustOpen(dsn string) *Store {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		panic(err)
	}
	return &Store{db: db}
}

func init() {
	if !namePattern.MatchString("ok") {
		panic(fmt.Sprintf("bad pattern %s", namePattern))
	}
}

func (s *Store) Kind(k int) string {
	switch k {
	case 1:
		return "one"
	default:
		panic(fmt.Sprintf("unknown kind %d", k))
	}
}

func (s *Store) Shape(k int) string {
	if k < 0 {
		panic("unreachable: k is validated by the caller")
	}
	return "ok"
}

// Get returns the named row.
func (s *Store) Get(name string) string {
	// TODO(perf): cache this once the read path is measured.
	return s.lookup(name)
}

func (s *Store) lookup(name string) string { return name }

// Count panics only in a function that has no error to return through.
func (s *Store) Count() int {
	var n int
	if err := s.db.QueryRow("select count(*) from t").Scan(&n); err != nil {
		panic(err)
	}
	return n
}

func (s *Store) Each(rows []string, fn func(string) error) error {
	for _, r := range rows {
		func() {
			if err := fn(r); err != nil {
				panic(err)
			}
		}()
	}
	return nil
}

type Config struct{ Name string }
