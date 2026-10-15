package server

import "os"

func Start() { //nolint
	os.Remove("/tmp/x") //nolint:all
	_ = os.Getenv("X") //nolint // all linters, with a reason after
}
