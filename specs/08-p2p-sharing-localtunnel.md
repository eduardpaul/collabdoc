# 08 · Share a session over localtunnel; join with a connection code

**Phase:** 2 · **Depends on:** 03, 04, 07 · **Status:** not started

## Summary

The host's main process opens a WebSocket server on loopback, exposes it through localtunnel, and shows a URL and a short connection code. A guest running CollabDoc enters the code, connects to the host's hub, receives a snapshot, and collaborates live. No CollabDoc server exists anywhere; the host is the authority for the session's lifetime.

## Current state (collabdoc)

- `toggle-share` creates a random `CD-XXXXXX` code and a fabricated `https://<slug>.loca.lt` URL; `ShareDialog` shows them; `JoinDialog` accepts a code and `join-session` loads placeholder text.
- `lib/ids.ts#shareUrlForCode` — the slug derivation is the right idea (code ↔ subdomain) and can stay.

## Reference (lorocollab)

- `server/index.ts` — WebSocket upgrade handling, snapshot on connect, binary frame relay, `broadcast`, and the origin/loopback guard with its threat-model comment.
- `client/App.tsx` — reconnect with backoff (`500 ms → 8 s`), `offlineFrom` version vector recorded at disconnect, replay of missed ops on reconnect, "the connection is not the session".
- `core/reconnect.test.ts`.
- `shared/protocol.ts` — control messages as JSON text frames, document bytes as binary frames.

## Review before adopting

- lorocollab has **no authentication** — anyone reaching the port is a peer. Over a public tunnel that is unacceptable. The join code must be a secret: derive a per-session `sessionSecret` (≥ 128 bits), show the human a short code that encodes tunnel subdomain + a 6-char check, and require the full secret in the WebSocket handshake (`Authorization` header); a guest gets the secret from the code via a key-derivation step or from the full share link. Decide between (a) long link + short verification code shown separately, or (b) a 10–12 char code that *is* the secret. Recommendation: (b), Crockford base32, 12 chars ≈ 60 bits, plus rate limiting (5 failed handshakes → 60 s lockout).
- localtunnel's free relay is best-effort, shows a reminder page on first browser visit (`bypass-tunnel-reminder` header needed — irrelevant for WS but relevant if we ever serve a web guest), and can assign a different subdomain than requested. The code must therefore be generated **after** the tunnel reports its URL, not before as the current mock does.
- The tunnel exposes plain `ws://` inside `https://` — localtunnel terminates TLS. Treat the relay as untrusted for confidentiality: encrypt frames end-to-end with a key derived from the session secret (libsodium `secretbox` / WebCrypto AES-GCM) so the relay sees ciphertext. This is cheap and removes the relay from the trust boundary.
- The server broadcast loop sends to every socket synchronously; add per-socket backpressure (`bufferedAmount` check) and drop ephemeral frames first.
- The "server restarted onto a fresh document" comment describes ops being held pending forever. In CollabDoc, a guest rejoining a *different* `docId` must be told so (error frame), not left pending.
- Guest-side persistence: a guest should keep a local copy (`drafts/<docId>.collabdoc`) so they can read after the host leaves, but must not be able to "reshare" as if they were the origin without an explicit "Fork as my own document" action.

## Design

- Main: `src/main/share/TunnelHost.ts` — `start(docId) → { url, code }`, `stop()`, `peers()`; wraps `ws` server bound to `127.0.0.1:0`, `localtunnel({ port })`, and a `SessionAuth` (secret, rate limiter). `src/main/share/GuestClient.ts` — connects, authenticates, encrypts, attaches to a local hub in the guest's main (so the guest's renderer, agents, and autosave all work the same as for a host).
- Handshake: `GET wss://<sub>.loca.lt/ws` with `Authorization: Bearer <secret>`; server replies `hello { docId, title, hostName, protocolVersion }` (JSON, encrypted), then `snapshot` (binary, encrypted), then live frames.
- Presence and identity from 07 flow as `ephemeral` frames; control messages (`peer-joined`, `peer-left`, `host-ending`, `error`) as JSON.
- Share dialog: Start sharing → shows status (`starting tunnel…`, `live`), the code in large text, copy-link, list of connected guests with a "remove" action, and Stop. Stopping sends `host-ending` and closes the tunnel.
- Join dialog: paste code or link, validate format locally, connect with progress and clear errors (`wrong code`, `host offline`, `version mismatch`).
- Reconnect: both sides use backoff (0.5 s → 8 s, jitter) and version-vector replay. Guest UI shows an "offline — edits will sync" banner; typing continues.
- Host leaves: guests get `host-ending`, the document becomes read-only locally with "Host ended the session · Save a copy".
- Feature flag `COLLABDOC_TUNNEL_PROVIDER` to swap localtunnel for a self-hosted `lt --port` server later without code changes.

## Acceptance criteria

- [ ] AC-08.1 Clicking "Start sharing" opens a localtunnel and shows a real URL and a code only after the tunnel is confirmed; the code, when entered on a second machine (or a second instance with a different `userData`), connects and shows the host's document within 3 s.
- [ ] AC-08.2 Edits typed on either side appear on the other within 200 ms over the tunnel; concurrent edits to the same paragraph converge without loss (Playwright test with two Electron instances).
- [ ] AC-08.3 A wrong code is rejected with "wrong code" and no snapshot is sent; after 5 wrong attempts from one IP the host refuses for 60 s; the host UI shows the attempts.
- [ ] AC-08.4 All frames on the wire are encrypted: a test that captures the loopback traffic between the `ws` server and the tunnel client finds no plaintext of a known document string.
- [ ] AC-08.5 Guest identity (07) appears in the host's participant list with the guest's name and color; the guest's edits are attributed to the guest in History (05) on both sides.
- [ ] AC-08.6 Killing the tunnel (simulate by closing the localtunnel client) triggers reconnect on the guest; edits typed during a 10 s outage are replayed and appear on the host; nothing is duplicated.
- [ ] AC-08.7 Stop sharing → guests see "Host ended the session", the editor becomes read-only, "Save a copy" writes a `.collabdoc` with full history, and the guest's later "Fork as my own document" creates a new `docId`.
- [ ] AC-08.8 A guest who already has a local copy of the same `docId` (rejoin after restart) joins with a delta, not a full snapshot, and the result equals the host's document.
- [ ] AC-08.9 The host can remove a guest; that guest is disconnected immediately and cannot reconnect with the same code (the session secret rotates and the host UI shows the new code).
- [ ] AC-08.10 Sharing a document that has never been saved first forces autosave (04) so that a crash mid-session leaves a file; sharing status is not persisted — after restart the document is not shared.
- [ ] AC-08.11 `hostAllowed`/`originAllowed` equivalents exist: the loopback `ws` server refuses connections that do not carry the tunnel's forwarding headers or a valid bearer, so a random local process cannot attach.
- [ ] AC-08.12 Activity (19) records `share started`, `guest joined/left`, `share stopped` with timestamps.

## Out of scope

Browser-only guests (no CollabDoc installed) — possible later by serving a web build through the tunnel; more than ~10 simultaneous guests; NAT hole-punching / WebRTC; host migration when the host disconnects.

## Open questions

- Whether to also offer LAN sharing without a tunnel (mDNS + direct `ws://` on the LAN). Cheap to add later since the transport is abstracted.
