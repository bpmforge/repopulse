package sync

import (
	"database/sql"
	"fmt"
	"os"
	"regexp"
)

func Owners(db *sql.DB, ids []int) []string {
	var out []string
	for _, id := range ids {
		var name string
		row := db.QueryRow("select name from owners where id = $1", id)
		if err := row.Scan(&name); err == nil {
			out = append(out, name)
		}
	}
	return out
}

func Touch(tx *sql.Tx, ids []int) error {
	for i := 0; i < len(ids); i++ {
		if _, err := tx.Exec("update t set seen = now() where id = $1", ids[i]); err != nil {
			return err
		}
	}
	return nil
}

func Filter(lines []string) []string {
	var out []string
	for _, l := range lines {
		re := regexp.MustCompile(`^\d+$`)
		if re.MatchString(l) {
			out = append(out, l)
		}
		if ok, _ := regexp.MatchString(`^x`, l); ok {
			out = append(out, l)
		}
	}
	return out
}

func Render(rows []string) string {
	s := ""
	for _, r := range rows {
		s += fmt.Sprintf("<li>%s</li>", r)
	}
	var csv string
	for _, r := range rows {
		csv += r
	}
	return s + csv
}

func Sizes(paths []string) (int64, error) {
	var total int64
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			return 0, err
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil {
			return 0, err
		}
		total += st.Size()
	}
	return total, nil
}
