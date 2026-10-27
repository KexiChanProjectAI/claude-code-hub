// Package redisx publishes CCH cache invalidations without logging Redis credentials.
package redisx

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Channels match src/lib/redis/pubsub.ts.
var Channels = []string{
	"cch:cache:providers:updated",
	"cch:cache:provider_endpoints:updated",
	"cch:cache:provider_groups:updated",
	"cch:cache:model_prices:updated",
}

// Publish sends one message to every cache channel. The payload is ignored by subscribers.
func Publish(ctx context.Context, redisURL, message string) error {
	parsed, err := url.Parse(redisURL)
	if err != nil || parsed.Scheme != "redis" || parsed.Host == "" {
		return fmt.Errorf("redis_unavailable")
	}
	dialer := net.Dialer{Timeout: 2 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", parsed.Host)
	if err != nil {
		return fmt.Errorf("redis_unavailable")
	}
	defer conn.Close()
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(2 * time.Second)
	}
	_ = conn.SetDeadline(deadline)
	reader := bufio.NewReader(conn)
	password, _ := parsed.User.Password()
	if password == "" {
		password = parsed.User.Username()
	}
	if password != "" {
		if err := command(conn, reader, "AUTH", password); err != nil {
			return err
		}
	}
	if database := strings.TrimPrefix(parsed.Path, "/"); database != "" && database != "0" {
		if err := command(conn, reader, "SELECT", database); err != nil {
			return err
		}
	}
	for _, channel := range Channels {
		if err := command(conn, reader, "PUBLISH", channel, message); err != nil {
			return err
		}
	}
	return nil
}

func command(conn net.Conn, reader *bufio.Reader, args ...string) error {
	if _, err := conn.Write(encode(args)); err != nil {
		return fmt.Errorf("redis_unavailable")
	}
	line, err := reader.ReadString('\n')
	if err != nil {
		return fmt.Errorf("redis_unavailable")
	}
	if strings.HasPrefix(line, "-") {
		return fmt.Errorf("redis_rejected")
	}
	if strings.HasPrefix(line, "$") {
		size, _ := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "$")))
		if size >= 0 {
			_, _ = reader.Discard(size + 2)
		}
	}
	return nil
}

func encode(args []string) []byte {
	var body strings.Builder
	fmt.Fprintf(&body, "*%d\r\n", len(args))
	for _, arg := range args {
		fmt.Fprintf(&body, "$%d\r\n%s\r\n", len(arg), arg)
	}
	return []byte(body.String())
}
