package app

import (
	"math/rand"
	"time"
)

// Backoff jitter only has to spread retries out; predictability is harmless.
func Backoff(attempt int) time.Duration {
	jitter := time.Duration(rand.Int63n(int64(time.Second)))
	return time.Duration(attempt)*time.Second + jitter
}

func SampleIndex(n int) int {
	return rand.Intn(n)
}
