package perf

import "archive/zip"

// Near-misses from the W21-20 hand-check: each shape below was marked wrong
// on real code, and no performance rule may fire on it.

// The defer runs once: its block returns right after it.
func manifest(zr *zip.Reader) (string, error) {
	for _, file := range zr.File {
		if file.Name == "manifest.json" {
			f, err := file.Open()
			if err != nil {
				return "", err
			}
			defer f.Close()
			return file.Comment, nil
		}
	}
	return "", nil
}

// A string declared inside the loop is fresh each time.
func labels(names []string) []string {
	out := make([]string, 0, len(names))
	for _, n := range names {
		label := n
		label += " (user)"
		out = append(out, label)
	}
	return out
}
