package main

import (
	"io"
	"log/slog"
	"net"
	"testing"
)

func TestListenFirstFreeSkipsBusyPort(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()

	ln, addr, err := listenFirstFree(busy.Addr().String(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if addr == busy.Addr().String() {
		t.Fatalf("bound the busy port %s", addr)
	}
}
