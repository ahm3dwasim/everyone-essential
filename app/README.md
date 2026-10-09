# The app

Everyone Is Essential is a couch game played on a TV and on the phones in the
room. This directory holds the three programs and the one protocol between
them.

- **`shared/`** — the wire protocol, in one place: the message vocabulary, the
  decoders for both directions, and the transport client the TV and the phones
  both use. Everything else here is written against it.
- **`relay/`** — the relay. It owns rooms and routes frames inside them. It is
  deliberately stupid: it does not know what a puzzle is, it does not read a
  game message, and it decides nothing about play. It checks that a sender may
  address a target and forwards the payload untouched.
- **`tv/`** — the TV, which is the authority. It holds the game, decides every
  intent a phone sends, and sends each phone the view that phone is allowed to
  see.
- **`phone/`** — the phone. It sends intents and renders what the TV sends it,
  and it holds no game state of its own.
- **`android/`** — the Fire TV build: a WebView around `tv/`, an embedded
  relay, and a Kotlin port of the protocol so the Stick can route on its own.

Run the relay with `npm run relay`, the TV page with `npm run tv`, and the
whole-headless run with `npm run smoke`. `npm test` covers the protocol, the
relay, the client and the game.

## Threat model

The game is played on a home network by people who are in the same room. That
is the setting everything below assumes.

**What is protected.** A room code is public — it is on the TV screen, in the
QR code and in the join link — so it can never be what makes a connection a
room's TV. The relay mints a credential when it makes a room and hands it to
that room's TV alone, and only a connection presenting it can be that room's
TV. The credential is single-use: every welcome a TV gets carries a fresh one
and the relay keeps only the digest of the newest, so the one a TV presented a
moment ago stops working at the moment it is handed the next. A room that
empties is remembered for a short window, so the code cannot be used to make
that room again and be welcomed as its TV while the real one is reconnecting.
The credential never appears in anything a phone receives.

**What is out of scope.** An attacker who can read or forge traffic on the
same Wi-Fi. The relay speaks cleartext `ws://` on the LAN, because a television
on a local IP address cannot be issued a TLS certificate, and such an attacker
can already read every game message and forge every one of them — the
credential among them. The credential is what stops someone who knows the room
code from taking the TV's place; it is not, and cannot be, a defence against
someone who is already on the wire. Phones are not trusted either: a phone
sends intents addressed to the TV, the relay refuses a phone that addresses
anything else, and the TV decides.

**What is not protected at all.** Nothing in the game is a secret from the
people playing it, and the relay keeps no record of a game beyond the rooms it
is routing in. There is no account, no server-side state and no data that
outlives a room.
