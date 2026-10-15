package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
)

type Store struct{ db *sql.DB }

func (s *Store) Limit(raw string) int {
	n, _ := strconv.Atoi(raw)
	return n
}

func (s *Store) Load(blob []byte, out *Config) {
	_ = json.Unmarshal(blob, out)
}

func (s *Store) Save(tx *sql.Tx) {
	_ = tx.Commit()
}

func (s *Store) Ping() {
	err := s.db.Ping()
	if err != nil {
	}
}

func (s *Store) Close() error {
	if err := s.db.Close(); err != nil {
		return nil
	}
	return nil
}

func (s *Store) Count() (int, error) {
	var n int
	row := s.db.QueryRow("select count(*) from t")
	if err := row.Scan(&n); err != nil {
		panic(err)
	}
	return n, nil
}

func (s *Store) Export() error {
	panic("not implemented")
}

func (s *Store) Archive() error {
	return errors.New("not implemented yet")
}

func (s *Store) Migrate() error {
	// TODO: implement migrations
	return nil
}

func (s *Store) Retry(n int) int {
	// increment the counter
	n++
	return n
}

type Config struct{ Name string }
