package main

import (
	"crypto/tls"
	"net/http"
	"os/exec"

	"github.com/gin-contrib/cors"
	rscors "github.com/rs/cors"
)

func client() *http.Client {
	return &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
}

func patch(cfg *tls.Config) {
	cfg.InsecureSkipVerify = true
}

func run(user string) ([]byte, error) {
	return exec.Command("sh", "-c", "grep "+user+" /etc/passwd").Output()
}

func handler() {
	_ = rscors.New(rscors.Options{AllowedOrigins: []string{"*"}, AllowCredentials: true})
	_ = cors.New(cors.Config{AllowCredentials: true, AllowAllOrigins: true})
}
