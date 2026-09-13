# 08 · Share a session peer-to-peer over Hyperswarm; join with a connection code

**Phase:** 2 · **Depends on:** 03, 04, 07 · **Status:** not started

## Summary

The host's main process joins a Hyperswarm topic derived from a per-session secret; guests running CollabDoc enter the code (or open the link), the DHT finds the host, Hyperswarm hole-punches an encrypted UDP connection, and the guest attaches to the host's hub exactly like the local renderer does. No CollabDoc server, no relay we operate, no exposed port. The host is the authority for the session's lifetime.

## Why Hyperswarm instead of localtunnel (decision, 2026-09-13)

|                         | localtunnel                                                                                                           | Hyperswarm                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Topology                | Relay through `loca.lt` (third-party server)                                                                          | Direct peer-to-peer over UDP; DHT only for discovery                                  |
| Encryption / auth       | TLS terminated at the relay; we would add E2E crypto + bearer auth ourselves                                          | Noise (XX) handshake per connection, mutually authenticated by keypairs, built in     |
| Attack surface on host  | HTTP + WebSocket server reachable from any web page on the host (`127.0.0.1`) and from the internet through the relay | No listening TCP/HTTP port; connections only from peers that pass the Noise handshake |
| Maintenance             | Last publish 2023; free relay is best-effort, rate-limited, shows an interstitial                                     | Actively released (Sept 2026); used in production by Holepunch apps                   |
| NAT traversal           | Not needed (relay) — always works if the relay is up                                                                  | Hole-punching; fails on some symmetric NATs — must be handled                         |
| External dependency     | The relay for the whole session                                                                                       | Public DHT bootstrap nodes for discovery only (configurable)                          |
| Browser guests          | Possible later by serving a web build                                                                                 | Not possible (UDP) — already out of scope                                             |
| Native code in Electron | None                                                                                                                  | `sodium-native`, `udx-native` (N-API prebuilds; must be verified per OS)              |

Decision: **Hyperswarm for v1.** The transport stays behind a `PeerTransport` interface so a relay-based transport can be added later for environments where hole-punching fails.

## Current state (collabdoc)

- `toggle-share` creates a random `CD-XXXXXX` code and a fabricated `https://<slug>.loca.lt` URL; `ShareDialog` shows them; `JoinDialog` accepts a code and `join-session` loads placeholder text.
- `lib/ids.ts#shareUrlForCode` is localtunnel-specific and goes away; `createShareCode` is replaced by a real secret generator in main.

## Reference (lorocollab)

- `server/index.ts` — snapshot on connect, binary frame relay, `broadcast`; the loopback/origin guard is **not** needed (no HTTP), but its threat-model comment is still the right way to think about who can reach the host.
- `client/App.tsx` — reconnect with backoff, `offlineFrom` version vector recorded at disconnect, replay of missed ops on reconnect, "the connection is not the session".
- `core/reconnect.test.ts`.
- `shared/protocol.ts` — control messages as JSON frames, document bytes as binary frames; keep the 1-byte tag scheme and add a length-prefix framing layer because a Hyperswarm connection is a byte stream, not a message socket.

## Review before adopting

- lorocollab has **no authentication**. Hyperswarm authenticates _keypairs_, not _people_: anyone who learns the topic hash from the DHT can complete a Noise handshake with the host. The join secret must therefore be proven at the application layer, **in both directions**, bound to the connection (see Design → Handshake).
- The `ws` broadcast loop has no backpressure. Hyperswarm connections are `streamx` duplexes; respect `write()` return values / `drain`, and drop `ephemeral` frames first when a peer is slow.
- "Server restarted onto a fresh document" leaves ops pending forever in lorocollab. In CollabDoc a guest reconnecting to a host that now has a _different_ `docId` on the same session must receive an explicit `error: doc-mismatch` frame.
- Guest-side persistence: guests keep a local `.collabdoc` copy (04) so they can read after the host leaves, but must not "reshare" as if they were the origin without an explicit "Fork as my own document" action.
- Verify on real networks before relying on it: (a) `udx-native`/`sodium-native` prebuilds load inside Electron 44 on Windows, macOS (arm64 + x64) and Linux without rebuild (`npmRebuild: false` is already set; native `.node` files must be unpacked from asar); (b) hole-punch success behind two home NATs, a mobile hotspot, and a corporate NAT; (c) whether HyperDHT relaying (`relayThrough`) rescues the symmetric-NAT case with the pinned `hyperdht` version. Record results in this spec's Open questions.

## Design

- **Packages**: `hyperswarm ^4.17`, `hyperdht ^6.34` (transitive), `b4a`, `compact-encoding` for framing. Main process only; the renderer never touches the swarm.
- **Session secret & code**: the code is the only material a guest has, so everything derives from it. Main generates `code = base32(random 8 bytes)` (12 Crockford base32 chars, shown as `K7QX-3M9P-2RHD` for readability, ≈ 60 bits), then `sessionSecret = HKDF(code, "collabdoc/session")` and `topic = HKDF(sessionSecret, "collabdoc/topic")` (32 bytes). The topic hash reveals nothing about the code. The **link** is `collabdoc://join/<hostPublicKey-base32>#<code>` — carrying the host's session public key lets a guest `dht.connect(publicKey)` directly and skip the topic lookup; the code alone falls back to `swarm.join(topic)` lookup.
- **Keys & identity**: each install has a long-lived Hyperswarm keypair in `safeStorage` (identity across sessions; its public key is added to the 07 user profile so guests are recognised on rejoin). The host uses a **per-session** keypair for the swarm so the share link does not leak the install identity; the install key is sent inside the authenticated channel.
- **Topology**: star. Host `swarm.join(topic, { server: true, client: false })`; guests `{ server: false, client: true }` — guests do not connect to each other in v1. Host caps peers at 10.
- **Handshake (application layer, after Noise)** — every connection, both directions:
  1. Host → guest: `hello { protocolVersion, docId, title, hostName, nonceH }`.
  2. Guest → host: `auth { nonceG, proof: HMAC(sessionSecret, handshakeHash ‖ nonceH ‖ "guest") , profile }`, where `handshakeHash` is `@hyperswarm/secret-stream`'s handshake hash (channel binding — a proof cannot be replayed on another connection).
  3. Host → guest: `auth-ok { proof: HMAC(sessionSecret, handshakeHash ‖ nonceG ‖ "host") }` then `snapshot`.
     Any failure → `error { code: wrong-code | version-mismatch | doc-mismatch | full | removed }` and destroy. 5 failed proofs from one remote public key or from any peer within 60 s → host stops accepting for 60 s and shows it.
- **Framing**: `[u32 length][u8 tag][payload]`; tags `hello/auth/auth-ok/error/control` (JSON) and `snapshot/update/ephemeral` (Loro bytes). Max frame 16 MB; oversize → destroy connection.
- **Sync**: after `auth-ok` the connection is registered as a hub subscriber (03) exactly like a `MessagePort`; `update`/`ephemeral` relay both ways; presence (07) rides on `ephemeral`; control messages `peer-joined`, `peer-left`, `host-ending`.
- **Assets**: image bytes (01/04) are not in the Loro document. A peer that sees an `asset:<hash>` it does not have sends `asset-request { hash }`; the owner replies with `asset { hash, type, bytes }` (chunked at 256 KB, lower priority than `update`); received assets are verified against the hash and stored locally. Figures show a placeholder until the asset arrives.
- **Reconnect**: guests keep the swarm joined and reconnect with backoff (0.5 s → 8 s, jitter); on reconnect they send `resume { fromVersion }` after auth and the host replies with an `update` delta (or `snapshot` if the version is unknown). Guest UI shows "offline — edits will sync"; typing continues. Host restart = new session (code changes) — guests are told `host-ending` if the host stops, otherwise they see "host unreachable" and keep retrying for 10 min.
- **Host leaves**: `host-ending` → guests' document becomes read-only with "Host ended the session · Save a copy".
- **Removal / rotation**: removing a guest destroys its connection, adds its public key to a session deny-list, and rotates the code (new secret/topic; existing guests are migrated silently by sending them the new topic inside the authenticated channel).
- **Discovery UX**: share dialog shows `announcing…` → `live` (once `swarm.flush()` resolves), the code in large text, copy-link, connected guests (name, color, connection type: direct/holepunched, relay if any), remove buttons, Stop. Join dialog shows `finding host… (n s)` → `connecting` → `verifying` → `joined`, with typed errors and a "Still trying" state up to 30 s before offering Retry.
- **Transport abstraction**: `src/main/share/PeerTransport.ts` (`listen(secret) → { publicKey, stop }`, `dial(link|code) → Connection`) with `HyperswarmTransport` and `MemoryTransport` (tests). A future `RelayTransport` is possible without touching the session/auth/sync layers.
- **Packaging**: `electron-builder.yml` — `asarUnpack: ["**/*.node", "node_modules/{sodium-native,udx-native}/prebuilds/**"]`; CI builds run a smoke test that loads the modules in the packaged app on each OS.
- **Privacy note in the share dialog**: "Discovery uses a public DHT; the topic hash is visible to DHT nodes, your document is not. Connections are direct and encrypted."

## Acceptance criteria

- [ ] AC-08.1 Clicking "Start sharing" shows a code and link only after the topic is announced (`swarm.flush()`); entering the code on a second machine on a different network connects and shows the host's document within 10 s (link form within 5 s); the same test with `MemoryTransport` runs in CI.
- [ ] AC-08.2 Edits typed on either side appear on the other within 200 ms once connected; concurrent edits to the same paragraph converge without loss (Playwright test with two Electron instances over `MemoryTransport`; nightly over real Hyperswarm).
- [ ] AC-08.3 A wrong code fails at the application handshake: no `snapshot` is sent, the guest sees "wrong code", and after 5 failed proofs within 60 s the host stops accepting for 60 s and shows the attempts.
- [ ] AC-08.4 Channel binding: replaying a captured `auth` frame on a new connection is rejected (unit test with two `MemoryTransport` connections); a connection whose Noise handshake completes but whose proof is missing after 10 s is destroyed.
- [ ] AC-08.5 All bytes on the wire are Noise-encrypted: a UDP capture between two real peers contains no plaintext of a known document string (nightly test); the framing layer adds no plaintext headers outside the encrypted stream.
- [ ] AC-08.6 Guest identity (07) appears in the host's participant list with the guest's name/color; the guest's edits are attributed to the guest in History (05) on both sides; a guest rejoining after restart is recognised by its install public key.
- [ ] AC-08.7 Killing the guest's network for 10 s (simulated by pausing the transport) triggers reconnect with backoff; edits typed during the outage are replayed via `resume { fromVersion }` and appear on the host with nothing duplicated.
- [ ] AC-08.8 Stop sharing → guests see "Host ended the session", the editor becomes read-only, "Save a copy" writes a `.collabdoc` with full history, and a later "Fork as my own document" creates a new `docId`.
- [ ] AC-08.9 A guest rejoining a host whose session now serves a different `docId` receives `error: doc-mismatch` and is not left pending; the UI explains it.
- [ ] AC-08.10 Removing a guest disconnects it within 1 s, denies its public key for the session, rotates the code, and keeps the other guests connected without user action.
- [ ] AC-08.11 The 11th guest is refused with `error: full`; slow guests (write buffer > 4 MB) have `ephemeral` frames dropped before `update` frames, and a guest stalled > 30 s is disconnected with `peer-left` reason `stalled`.
- [ ] AC-08.12 Sharing a never-saved document first forces autosave (04); sharing state is not persisted — after restart the document is not shared and the old code no longer works.
- [ ] AC-08.13 The host process has no listening TCP socket attributable to sharing (`ss -ltnp` / `netstat` assertion in CI on Linux); only the UDP socket used by `udx` exists.
- [ ] AC-08.14 Packaged builds on Windows, macOS (x64 + arm64) and Linux load `sodium-native` and `udx-native` without rebuild and complete a `MemoryTransport`-free loopback swarm smoke test (two swarms in one process) — run in CI on each OS.
- [ ] AC-08.15 When hole-punching fails (simulated by a transport that never completes), the join dialog reports "Could not reach the host directly (network restrictions)" within 30 s with a link to the troubleshooting note; the host sees the failed attempt.
- [ ] AC-08.17 A guest joining a document with 5 images sees text immediately and all images within 5 s on a LAN; a corrupted asset (hash mismatch) is rejected and re-requested once; asset transfer never delays `update` frames by more than 100 ms (measured with a 20 MB asset set).
- [ ] AC-08.16 Activity (19) records `share started`, `guest joined/left` (with connection type), `share stopped`, `code rotated`, and auth failures with timestamps.

## Out of scope

Browser-only guests; more than 10 simultaneous guests; a relay/gateway transport for networks where hole-punching fails (interface reserved); host migration when the host disconnects; LAN-only discovery (mDNS) — Hyperswarm already connects directly on the same LAN.

## Open questions

- HyperDHT relaying for symmetric NATs: verify with the pinned `hyperdht` version and real networks; if reliable, promote it from "clear failure" (AC-08.15) to a fallback path. Record measurements here.
- Whether to run our own DHT bootstrap node as a fallback config (`bootstrap: [...]`) for corporate environments.
