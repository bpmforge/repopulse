package api

import (
	"fmt"
	"log"
	"log/slog"
	"net/http"
)

type Handler struct {
	logger *slog.Logger
	repo   Repo
}

type Repo interface{ Find(id string) (string, error) }

func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	fmt.Println("searching for", q)
	log.Printf("search query: %s", q)
	user := r.FormValue("user")
	log.Println("login attempt by " + user)
}

func (h *Handler) Login(user, password, accessToken string, cfg Config) {
	log.Printf("login %s with %s", user, password)
	h.logger.Info("issued", "token", accessToken)
	slog.Debug("config loaded", "key", cfg.APIKey)
}

func (h *Handler) Find(id string) (string, error) {
	v, err := h.repo.Find(id)
	if err != nil {
		h.logger.Error("find failed", "err", err)
		return "", err
	}
	return v, nil
}

func (h *Handler) Load(id string) error {
	_, err := h.repo.Find(id)
	if err != nil {
		log.Printf("load %s: %v", id, err)
		return fmt.Errorf("load: %w", err)
	}
	return nil
}

type Config struct{ APIKey string }
