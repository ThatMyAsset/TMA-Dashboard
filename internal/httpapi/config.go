package httpapi

import (
	"errors"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddr     string
	AdminUsername  string
	AdminPassword  string
	AdminAPIToken  string
	SecureCookies  bool
	TrustProxy     bool
	AllowedOrigins map[string]bool
	SessionTTL     time.Duration
}

func ConfigFromEnv() (Config, error) {
	secure, err := envBool("COOKIE_SECURE", true)
	if err != nil {
		return Config{}, err
	}
	trustProxy, err := envBool("TRUST_PROXY", false)
	if err != nil {
		return Config{}, err
	}
	origins := map[string]bool{}
	for _, raw := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return Config{}, errors.New("ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins")
		}
		origins[strings.ToLower(u.Scheme+"://"+u.Host)] = true
	}
	cfg := Config{
		ListenAddr: envDefault("LISTEN_ADDR", ":8080"), AdminUsername: strings.ToLower(strings.TrimSpace(os.Getenv("ADMIN_USERNAME"))),
		AdminPassword: os.Getenv("ADMIN_PASSWORD"), AdminAPIToken: os.Getenv("ADMIN_API_TOKEN"), SecureCookies: secure,
		TrustProxy: trustProxy, AllowedOrigins: origins, SessionTTL: 8 * time.Hour,
	}
	if cfg.AdminUsername == "" || len(cfg.AdminPassword) < 12 {
		return Config{}, errors.New("ADMIN_USERNAME is required and ADMIN_PASSWORD must contain at least 12 characters")
	}
	if len(cfg.AdminPassword) > 72 {
		return Config{}, errors.New("ADMIN_PASSWORD cannot exceed 72 bytes")
	}
	if cfg.AdminAPIToken != "" && len(cfg.AdminAPIToken) < 32 {
		return Config{}, errors.New("ADMIN_API_TOKEN must contain at least 32 characters")
	}
	return cfg, nil
}

func envDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func envBool(key string, fallback bool) (bool, error) {
	value := os.Getenv(key)
	if value == "" {
		return fallback, nil
	}
	return strconv.ParseBool(value)
}
