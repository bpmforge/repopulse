package server

import "os"

const prose = "//nolint"
const raw = `
//nolint
`

func Start() {
	os.Remove("/tmp/x") //nolint:errcheck // best effort cleanup
	// use //nolint only with a linter name
	_ = prose + raw
}
