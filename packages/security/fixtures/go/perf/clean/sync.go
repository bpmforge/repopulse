package sync

import (
	"database/sql"
	"os"
	"regexp"
	"strings"
)

var digits = regexp.MustCompile(`^\d+$`)

func Owners(db *sql.DB, ids []int) ([]string, error) {
	rows, err := db.Query("select name from owners where id = any($1)", ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

func Touch(db *sql.DB, ids []int) error {
	stmt, err := db.Prepare("update t set seen = now() where id = $1")
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, id := range ids {
		if _, err := stmt.Exec(id); err != nil {
			return err
		}
	}
	return nil
}

func Lookup(cache map[string]string, keys []string) []string {
	var out []string
	for _, k := range keys {
		out = append(out, cache[k])
	}
	return out
}

func Filter(lines []string) []string {
	var out []string
	for _, l := range lines {
		if digits.MatchString(l) {
			out = append(out, l)
		}
	}
	return out
}

func Render(rows []string) string {
	var b strings.Builder
	total := 0
	for _, r := range rows {
		b.WriteString(r)
		total += len(r)
	}
	return b.String()
}

func Sizes(paths []string) (int64, error) {
	var total int64
	for _, p := range paths {
		n, err := func() (int64, error) {
			f, err := os.Open(p)
			if err != nil {
				return 0, err
			}
			defer f.Close()
			st, err := f.Stat()
			if err != nil {
				return 0, err
			}
			return st.Size(), nil
		}()
		if err != nil {
			return 0, err
		}
		total += n
	}
	return total, nil
}
