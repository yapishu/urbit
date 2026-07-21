# Ames over QUIC and WebTransport

This document describes the Ames-over-QUIC system as it exists in the
`urbit` and `vere` worktrees. It covers the packet mapping, routing model,
kernel/runtime interface, native Vere integration, browser/WASM runtime
surface, and the commands used to run the local fake-galaxy demos.

## 1. Goal

Browsers cannot open UDP sockets. A ship running in a browser therefore needs
a browser-native datagram path to speak Ames. WebTransport is the browser API
for datagrams over HTTP/3, and HTTP/3 runs over QUIC. Native Vere can also use
raw QUIC directly for ship-to-ship and relay-to-ship links.

The system has three transport surfaces:

- **UDP Ames**, unchanged, remains the default native transport.
- **Raw QUIC Ames**, `alpn=ames/1`, carries Mesa packets between native
  runtimes and relay endpoints.
- **WebTransport Ames**, `CONNECT :protocol=webtransport` on `/~_~/ames`,
  carries browser-originated packets through a WebTransport endpoint.

QUIC is a lane type. It does not replace Ames authentication, packet formats,
Mesa pact encoding, sponsor routing, or UDP compatibility.

## 2. Invariants

The transport preserves the properties Ames already depends on:

- **End-to-end packet authentication.** QUIC TLS is hop encryption only.
  Ames/Mesa signatures and MACs remain the security boundary. Relays are not
  trusted with plaintext authority.
- **Packet-granular delivery.** The transport does not impose message or flow
  ordering. Each Ames/Mesa packet remains an independent unit.
- **Trustless relay.** A relay forwards packets and records lanes; it does not
  need to interpret application payloads.
- **Kernel/runtime split.** Arvo sees lanes and blobs. Vere owns sockets,
  QUIC sessions, WebTransport sessions, and lane realization.
- **UDP coexistence.** Native UDP Ames continues to work. QUIC is an
  additional lane, not a wire-format fork.

## 3. Packet Transport

One Ames/Mesa packet maps to one QUIC DATAGRAM when it fits the session's
current datagram size. The payload is byte-for-byte identical to the UDP
payload.

If a packet does not fit in a QUIC datagram, the sender opens one
unidirectional QUIC stream, writes exactly that packet, and closes the stream.
The receiver treats the stream contents as one packet. This fallback makes MTU
a performance boundary rather than a correctness boundary while preserving
packet-level independence between Ames messages.

Raw QUIC sessions carry Mesa packets only. Legacy non-Mesa Ames packets remain
on UDP or on the explicit WebTransport-to-UDP bridge. A non-Mesa packet
received on a raw QUIC session is dropped; there is no correct legacy UDP
origin lane to synthesize for a connection-shaped session.

## 4. TLS and Browser Trust

QUIC requires TLS 1.3. Raw QUIC peer links use self-signed certificates and do
not use TLS identity for ship authentication. Ship identity is authenticated by
Ames/Mesa packets, as on UDP.

Browser WebTransport clients must satisfy browser certificate rules. In local
development the bridge runs with a self-signed ECDSA P-256 certificate whose
validity is at most 14 days. The browser trusts it with
`serverCertificateHashes`, which pins the SHA-256 of the DER certificate.
This is not the SPKI hash. The Go bridge's `-dev` mode prints the correct
base64 hash.

The WebTransport bridge accepts all request origins. Browser origin checks are
not an Ames security boundary, and they break the intended cross-origin local
development shape. Ames payloads are end-to-end authenticated.

## 5. Relay Topology

Browser ships are dial-only. A browser ship dials its sponsor chain endpoint
and keeps the WebTransport session open. Inbound traffic for that browser
ship returns through the same relay session.

Typical browser-to-native local demo topology:

```text
browser WASM fake ~marzod
  -> WebTransport bridge
  -> fake galaxy ~zod
  -> raw QUIC session
  -> native fake ~binzod
```

Native fake-galaxy topology:

```text
fake ~marzod -> raw QUIC -> fake galaxy ~zod -> raw QUIC -> fake ~binzod
```

Mesa relay forwarding is PIT-based. When a galaxy forwards a request toward a
target, it records the requester lane keyed by packet name. When the page
response returns, the response is sent to the recorded lanes and the PIT entry
is removed. A recorded session lane that has died simply drops the response,
which the requester experiences as ordinary packet loss.

## 6. Session Lanes

A live QUIC or WebTransport session can be represented to Mesa as an opaque
`lane:pact` atom:

```text
(1 << 63) | session-id
```

Bit 63 makes the session-lane space disjoint from ip:port chubs and galaxy
atoms. The runtime mints this atom when injecting a packet heard on a session.
The kernel stores and echoes it opaquely. The runtime resolves it back to a
live session when routing a `%push`.

Mesa `HOP_LONG` carries advertised QUIC endpoints without changing the pact
wire format:

```text
0x01 | ipv4 | port    raw QUIC over IPv4
0x02 | ipv6 | port    raw QUIC over IPv6
```

Old parsers skip unknown `HOP_LONG` payloads by length. Browser peers do not
advertise their own session lanes, since a browser cannot accept inbound
connections. When a relay forwards a packet that arrived over a session, it
stamps the relay's public QUIC endpoint as the origin hop rather than leaking
the private session id.

## 7. Verified Binding

Outbound traffic over a session does not require a binding. Inbound relay
routing to a ship over a session does require proof that the ship controls the
session.

The kernel is the verification authority. After Mesa has decrypted and
authenticated a direct Gall `%ping` poke heard over a bit-63 session lane, Ames
emits this gift:

```hoon
[%bind =ship rift=@ bone=@ seq=@ =lane:pact]
```

The runtime decodes the session lane and binds `ship -> session` if the
freshness tuple is strictly newer than the previous binding:

```text
(rift, bone, seq)
```

The comparison is lexicographic. Rift supersedes all older rifts; bone
distinguishes flows within a rift; sequence orders pings in a flow. The
freshness horizon survives session close so a replayed old ping cannot steal a
new binding.

Session death is reported to the kernel with:

```hoon
[%fell =ship =lane]
```

Ames invalidates the route only if the current route still matches that lane.
This compare-and-invalidate rule is race-safe if a fresher route was learned
between session close and event processing.

The `%bind` gift and `%fell` task are additive local Vere/Arvo interface tags.
They do not change UDP Ames, Mesa packet formats, pact encoding, or network
wire compatibility. They are self-gated under version skew: `%bind` is emitted
only for session-shaped lanes, and `%fell` is injected only for ships that
were bound through `%bind`.

## 8. Native Vere Surface

The native runtime uses ngtcp2, nghttp3, and picotls under the Zig build. The
raw QUIC backend generates a per-backend stateless-reset secret at startup.
Reset tokens are not derived from a compile-time network-wide constant.

Important runtime flags:

```text
--ames-quic-port PORT       listen for raw QUIC Ames on PORT, or 0 for off
--ames-quic-sponsor         route sponsor galaxy lanes through raw QUIC
--ames-quic-sponsor-port P  override local sponsor QUIC port selection
--no-ames-mdns              disable fake-ship mDNS discovery
--ames-quic-log             emit narrow bind/forward QUIC evidence
```

Native Mesa send selection consults the live session binding table before
falling back to the cached UDP lane. The cached UDP lane remains the UDP route;
session reachability is resolved at send time.

The implementation keeps the portable session table free of libuv and nouns so
the same code can compile for WASM. The native tests cover:

- session freshness and supersession;
- session-lane encoding disjointness;
- `%bind` and `%fell` paths;
- raw QUIC handshake and DATAGRAM transport;
- advertised raw-QUIC endpoint dialing;
- bound relay egress selection.

## 9. Browser and WASM Surface

The browser code lives under `vere/tools/ames-wt-bridge/web/`.

The browser transport and protocol modules provide:

- Mesa pact encode/decode for `%peek`, `%page`, and `%poke`;
- WebTransport connection management with DER certificate hash pinning;
- one-packet datagram-or-one-shot-stream send/receive helpers;
- browser-held suite-B comet identity material;
- IndexedDB persistence for the default browser comet;
- comet proof page signing, verification, and automatic proof responses;
- Mesa `%chum` path sealing, encryption, HMAC binding, and one-fragment
  encrypted `%poke` helpers;
- effect decoding for Mesa `%push` and `%bind`;
- a browser-side session route table;
- a resident WASM runtime service that can start, inject events, pump packets,
  save, replay, and shut down.

The WASM runtime artifacts are smoke-runtime artifacts, not a complete
production browser Vere. They compile and run enough of the noun/Mars/disk
path to boot a fake ship from a brass pill, persist an event log through
hostfs/IndexedDB, inject Mesa events, extract network effects, and commit
replies back as `%heer` events.

Browser memory is explicit. Native Vere's default `--loom 31` is 2GB; that is
too large to treat casually in a 32-bit WASM linear-memory address space.
`U3_OS_wasm` defaults to `--loom 28` and rejects loom exponents above 31. The
route smoke defaults to `--loom 29` with 512MiB of browser headroom and a
1536MiB maximum memory plan.

### Browser TUI and HTTP Status

There is a browser control page at:

```text
tools/ames-wt-bridge/web/index.html
```

It is a developer console for WebTransport, Mesa pact packets, identity/proof
helpers, and WASM smoke buttons. It is not a browser webterm or a full Urbit
TUI.

The browser WASM runtime can make outbound HTTP requests through a hosted
`%http-client` adapter. Runtime startup commits `%http-client %born`; the JS
host decodes `%request` and `%cancel-request` effects, performs browser
`fetch()`, and injects `%receive` ova back into the resident runtime. Browser
CORS rules still apply.

The browser WASM runtime does not yet expose an inbound Eyre/http-server from
the fake browser ship. The local harnesses do start native fake ships with
loopback HTTP control planes, and the demo serves static browser assets with
Python's `http.server`, but the browser pier itself is not serving webterm or
Eyre apps.

## 10. Running the Demos

Commands below assume the repos are siblings:

```text
/home/reid/gits/tlon/urbit
/home/reid/gits/tlon/vere
```

Build the native binary, native checks, and browser WASM artifact:

```sh
cd /home/reid/gits/tlon/vere
zig build
zig build pact-test mesa-test ames-test quic-loopback vere-disk-wasm
```

Run the browser fake-galaxy proof from fresh piers:

```sh
cd /home/reid/gits/tlon/vere
KEEP_WORK=1 tools/ames-wt-bridge/demo-browser-fake-galaxy.sh
```

Success markers:

```text
FINAL_STATUS=ok
initial-sent=1
reply-packets=1
replay-exit=0
browser fake-galaxy demo completed
```

The harness logs its work directory. Inspect:

```sh
tail -80 /tmp/ames-quic-browser-galaxy.XXXXXX/browser-smoke.log
tail -80 /tmp/ames-quic-browser-galaxy.XXXXXX/bridge.log
tail -120 /tmp/ames-quic-browser-galaxy.XXXXXX/zod.log
```

Run the native fake-galaxy raw-QUIC proof:

```sh
cd /home/reid/gits/tlon/vere
KEEP_WORK=1 tools/ames-wt-bridge/demo-fake-galaxy.sh
```

Success markers in the fake galaxy log include two raw QUIC handshakes, two
session binds, and relay forwarding over bound destination sessions.

### Reusing Prepared Fake Piers

Fresh fake boot can be slow. To prewarm a clean browser demo baseline:

```sh
cd /home/reid/gits/tlon/vere
KEEP_WORK=1 PREPARE_ONLY=1 tools/ames-wt-bridge/demo-browser-fake-galaxy.sh
```

The harness prints a work directory. Reuse that prepared baseline:

```sh
REUSE_PIERS=1 WORK_DIR=/tmp/ames-quic-browser-galaxy.XXXXXX \
  tools/ames-wt-bridge/demo-browser-fake-galaxy.sh
```

Prepare mode exits after the fake piers report readiness and before any
binding or relay traffic. Child piers are prepared without
`--ames-quic-sponsor`; sponsor wiring is added only in the real reuse run.
Reuse resumes fake piers with `-L`, not `-F`. Kept artifacts from after a
network demo are not guaranteed reusable because sponsor peer state may have
advanced past a child checkpoint.

The native harness supports the same pattern:

```sh
KEEP_WORK=1 PREPARE_ONLY=1 tools/ames-wt-bridge/demo-fake-galaxy.sh
REUSE_PIERS=1 WORK_DIR=/tmp/ames-quic-fake-galaxy.XXXXXX \
  tools/ames-wt-bridge/demo-fake-galaxy.sh
```

### Manual Browser Pages

Serve the parent workspace so the browser can fetch both sibling repos:

```sh
cd /home/reid/gits/tlon/vere
python3 -m http.server 8093 --directory ..
```

The interactive developer page is:

```text
http://localhost:8093/vere/tools/ames-wt-bridge/web/index.html
```

The auto-running browser route smoke page is:

```text
http://localhost:8093/vere/tools/ames-wt-bridge/web/wasm-vere-disk-route-smoke.html?url=https://127.0.0.1:18443/~_~/ames&hash=<bridge-dev-cert-sha256>&fake-ship=0x100&peer=0x200
```

The browser fake-galaxy harness starts the bridge, Python asset server, Chrome,
and CDP waiter automatically. Manual page runs need a running bridge and the
bridge's printed dev certificate hash.

## 11. Focused Checks

Run these from the Vere repo:

```sh
bash -n tools/ames-wt-bridge/demo-browser-fake-galaxy.sh
bash -n tools/ames-wt-bridge/demo-fake-galaxy.sh
(cd tools/ames-wt-bridge && go test ./...)
node --test tools/ames-wt-bridge/web/*.test.mjs
git diff --check
```

Run this from the Urbit repo:

```sh
git diff --check
```

The full Ames Hoon suite is also expected to pass on a fresh brass fake-ship
boot through the current migration. Use a fresh copied `pkg/` tree for that
suite so `base-dev` symlinks survive; do not test against a stale copied desk.

## 12. Production Hardening

The local implementation proves the browser-WASM fake-ship route and native
raw-QUIC relay route. Production deployment still needs:

- native WebTransport service inside Vere, replacing the Go bridge on the
  browser-facing endpoint;
- a policy for when native peers prefer QUIC over known UDP lanes, including
  dial backoff and fallback;
- crash-safe browser pier storage and checkpoint replay;
- a hosted browser event loop that is not organized around smoke-page
  orchestration;
- inbound browser-hosted Eyre/http-server support if a browser webterm or web
  UI is required;
- parity hardening for browser-hosted `%http-client`, including CORS behavior,
  redirect/retry policy, and live docket/glob validation;
- production certificate provisioning for browser relay endpoints.
