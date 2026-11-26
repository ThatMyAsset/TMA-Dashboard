package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/thatmyassets/tma-dashboard/internal/httpapi"
	"github.com/thatmyassets/tma-dashboard/internal/model"
	"github.com/thatmyassets/tma-dashboard/internal/store"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	if err := run(); err != nil {
		slog.Error("control plane stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := httpapi.ConfigFromEnv()
	if err != nil {
		return err
	}
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	bootCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	storage, err := store.Open(bootCtx, databaseURL)
	if err != nil {
		return err
	}
	defer storage.Close()
	if err := waitForDatabase(bootCtx, storage); err != nil {
		return err
	}
	if err := storage.Migrate(bootCtx); err != nil {
		return err
	}
	passwordHash, err := httpapi.HashAdminPassword(cfg.AdminPassword)
	if err != nil {
		return err
	}
	if err := storage.Bootstrap(bootCtx, cfg.AdminUsername, passwordHash, model.DefaultPolicy()); err != nil {
		return err
	}
	server, err := httpapi.NewServer(storage, cfg)
	if err != nil {
		return err
	}
	httpServer := &http.Server{Addr: cfg.ListenAddr, Handler: server.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()
	slog.Info("control plane listening", "address", cfg.ListenAddr)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func waitForDatabase(ctx context.Context, storage *store.Store) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := storage.Ping(ctx); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
