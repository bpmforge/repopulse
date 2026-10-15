package main

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"os/exec"

	"github.com/gin-contrib/cors"
	rscors "github.com/rs/cors"
)

func client(pool *x509.CertPool, insecure bool) *http.Client {
	return &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, InsecureSkipVerify: insecure}}}
}

func strict(cfg *tls.Config) {
	cfg.InsecureSkipVerify = false
}

func run(user string) ([]byte, error) {
	out, err := exec.Command("sh", "-c", "uptime | cut -d, -f1").Output()
	if err != nil {
		return nil, err
	}
	_, err = exec.Command("grep", user, "/etc/passwd").Output()
	return out, err
}

func handler() {
	_ = rscors.New(rscors.Options{AllowedOrigins: []string{"https://app.example.com"}, AllowCredentials: true})
	_ = cors.New(cors.Config{AllowAllOrigins: true})
}
