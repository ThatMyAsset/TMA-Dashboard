package httpapi

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

type rateWindow struct {
	start time.Time
	count int
}
type rateLimiter struct {
	mu        sync.Mutex
	clients   map[string]rateWindow
	limit     int
	window    time.Duration
	lastSweep time.Time
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{clients: map[string]rateWindow{}, limit: limit, window: window}
}
func (l *rateLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastSweep) > l.window {
		for k, v := range l.clients {
			if now.Sub(v.start) >= l.window {
				delete(l.clients, k)
			}
		}
		l.lastSweep = now
	}
	entry := l.clients[key]
	if entry.start.IsZero() || now.Sub(entry.start) >= l.window {
		entry = rateWindow{start: now}
	}
	entry.count++
	l.clients[key] = entry
	return entry.count <= l.limit
}
func (s *Server) rateLimit(limiter *rateLimiter, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !limiter.allow(clientIP(r, s.cfg.TrustProxy), time.Now()) {
			w.Header().Set("Retry-After", strconv.Itoa(int(limiter.window.Seconds())))
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests; try again later")
			return
		}
		next(w, r)
	}
}
