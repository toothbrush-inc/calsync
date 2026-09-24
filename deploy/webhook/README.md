# Google push notification endpoint

The daemon's webhook receiver binds loopback (`CALSYNC_WEBHOOK_HOST`,
`CALSYNC_WEBHOOK_PORT`). A reverse proxy terminates TLS on a real hostname and
forwards the notification path to it.

Google will only deliver to an `https://` address whose certificate is
CA-signed and matches the hostname. Self-signed certificates, bare IP
addresses, and revoked certificates are all rejected.

## Caddy

```caddyfile
calsync.example.com {
	handle /gcal/webhook {
		reverse_proxy 127.0.0.1:8787
	}
}
```

Caddy obtains and renews the certificate itself. Then set:

```sh
CALSYNC_WEBHOOK_URL=https://calsync.example.com/gcal/webhook
```

## nginx

```nginx
location = /gcal/webhook {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    # Google sends its channel metadata in X-Goog-* headers; pass them through.
    proxy_pass_request_headers on;
}
```

If the proxy rewrites the path before forwarding, set `CALSYNC_WEBHOOK_PATH` to
the path the daemon actually receives.

## Verifying

1. Restart the daemon and look for `webhook_listening`, then
   `webhook_channel_armed` for both roles in the log.
2. Google sends a handshake immediately after a channel is armed; the daemon
   logs `webhook_channel_ready` and does not sync on it.
3. Change an event in either calendar. Within the debounce window the log
   shows `webhook_notification` followed by a `reconcile_complete` carrying
   `"trigger":"webhook"`.

If notifications never arrive, the channel is still armed and the backstop pass
keeps the mirrors correct — check that the proxy forwards POST (not just GET)
and that the address in `CALSYNC_WEBHOOK_URL` is reachable from the public
internet.
