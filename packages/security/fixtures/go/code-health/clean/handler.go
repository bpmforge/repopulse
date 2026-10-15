package api

import (
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"strconv"
)

type Handler struct {
	logger *slog.Logger
	repo   Repo
}

type Repo interface{ Find(id string) (string, error) }

func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	// Structured fields are encoded by the handler: a newline cannot forge a line.
	h.logger.Info("search", "q", q)
	// %q escapes control characters.
	log.Printf("search query: %q", q)
	page, err := strconv.Atoi(r.FormValue("page"))
	if err != nil {
		http.Error(w, "bad page", http.StatusBadRequest)
		return
	}
	log.Printf("page %d", page)
	fmt.Fprintf(w, "ok")
}

func (h *Handler) Login(user, password, accessToken string) {
	log.Printf("invalid password for %s", user)
	h.logger.Info("issued token", "len", len(accessToken), "tokenCount", 1)
	slog.Debug("password check", "present", password != "")
	h.logger.Error(fmt.Sprintf("could not determine token owner for %s", user))
	h.logger.Warn("refresh failed", "err", refreshTokenErr(user))
}

func refreshTokenErr(user string) error { return fmt.Errorf("refresh for %s", user) }

func (h *Handler) Find(id string) (string, error) {
	v, err := h.repo.Find(id)
	if err != nil {
		return "", fmt.Errorf("find %s: %w", id, err)
	}
	return v, nil
}

func (h *Handler) Serve(id string) {
	_, err := h.repo.Find(id)
	if err != nil {
		h.logger.Error("serve failed", "err", err)
		return
	}
}
