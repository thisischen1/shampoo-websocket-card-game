# Shampoo

A multiplayer card game for 2–5 players, each on their own phone or laptop.
One Node process serves the page and runs the game; no build step, no database,
one runtime dependency (`ws`).

## Why this exists

Shampoo is the card game my friends and I play. It needs a deck, a table, and
everyone in the same room — and when none of those lined up, we couldn't play.
I went looking for an online version and there wasn't one worth using, so I
built it: same rules, no physical cards, everyone on the phone already in their
hand.

That constraint drove the whole design. Each player sees only their own cards,
which means the server has to be the single source of truth and the client can
never be trusted — so there is exactly one function that decides what each seat
is allowed to see, and a test suite whose job is to prove nothing leaks past it.
The rest of the engineering below falls out of that one requirement.

## Running it

Needs **Node 20 or newer** and nothing else — no build step, no database.

> If `node` is not found, Homebrew installed it somewhere off your `PATH`. Run
> this once per terminal:
>
> ```sh
> export PATH=/opt/homebrew/bin:$PATH
> ```

```sh
npm install
npm start           # http://localhost:3000
npm run dev         # same, restarts on file changes
npm test            # the whole suite
```

### Playing with people in the same room

The server binds `0.0.0.0`, so other devices on your wifi can reach it. Find
your machine's LAN address and share that URL:

```sh
ipconfig getifaddr "$(route -n get default | awk '/interface/{print $2}')"
# e.g. 192.168.1.42
```

(`en0` is the usual Wi-Fi interface but not always — asking the routing table
which one carries your default route works wherever the uplink happens to be.)

Everyone opens `http://192.168.1.42:3000`. One person creates a room and reads
out the four-character code; the rest join with it. A room link
(`http://192.168.1.42:3000/?r=K7QM`) prefills the code.

## Putting it on the internet

Everything the server knows lives in its own memory. That is a deliberate
trade — no database to run, no migrations, scores that vanish with the room —
and it has exactly one consequence you must respect when you deploy:

> **Run exactly one instance. Turn autoscaling off.**
>
> There is no shared store, so a second instance holds a different set of
> rooms, and a code only exists on the machine that minted it. A player who
> lands on the wrong one is told **"No room with that code"** — which is a lie.
> The code is fine; they are talking to the wrong machine. So they retype it,
> the load balancer sends them somewhere else, it works, and the bug now looks
> random and unreproducible. That is the real cost: not an outage, but an error
> message that points at the wrong culprit.
>
> Railway defaults to one replica. Fly does not: `fly.toml` sets a *floor*, and
> `fly deploy` creates a high-availability **pair** unless told otherwise — so
> the Fly steps below pass `--ha=false` and then set the ceiling explicitly.
> It is the setting to re-check after any change to a plan or region.

Two things make a breach of that rule visible instead of mystifying:

```sh
curl https://your-app.up.railway.app/healthz    # {"ok":true,"instance":"94f020cc"}
```

Call it twice. **A changing `instance` means you are running more than one**, and
room codes are being split across them. On Fly the server also counts its own
siblings at boot (one AAAA record per machine on `<app>.internal`, so no API
token needed) and prints an unmissable error naming the fix if it is not alone.
It still starts — refusing to boot would turn a degraded game into no game.
Railway has no equivalent, which is why `/healthz` exists at all.

The code needs nothing added for either platform. It already binds `0.0.0.0`
and reads `process.env.PORT`, and the browser picks its websocket scheme from
the page's, so an `https://` deploy connects over `wss://` on its own.

### Railway

This is the path this app is deployed on, so it is the one written from
experience. No CLI, no config to edit — Railway builds straight from GitHub.

1. Push this repo to GitHub.
2. [railway.com](https://railway.com) → sign up, authorise GitHub.
3. **New Project → Deploy from GitHub repo** → pick the repo. It builds
   immediately, reading the `Procfile` for the start command.
4. Open the service → **Settings → Networking → Generate Domain**.

   **Take the port Railway offers and do not override it.** It reads the port
   from the running process, and the server reads `process.env.PORT` — so they
   already agree. Typing `3000` here points the domain at a port nothing is
   listening on, and every single connection fails.
5. **Settings → Deploy → Replicas** — confirm it reads **1**. It is the default,
   so this is a confirmation, not a change. It is also the one number that
   breaks room codes if it ever moves, and nothing will warn you.

Pushes to `main` redeploy on their own, which is the one thing to keep in mind
while people are playing: **a redeploy restarts the process and drops every live
room.** If auto-deploy is not firing, check **Settings → Source** — a failed
GitHub App authorisation shows up there as an error loading branches.

Railway's logs (the **Deployments** tab) print the boot line with the instance
id, so you can confirm the id that `/healthz` reports — see **Checking the
deploy** below — is the process you just deployed.

### Fly.io

An alternative. The `fly.toml` in this repo is correct but, unlike the Railway
path above, has not been exercised end to end.

```sh
brew install flyctl
fly auth signup                     # or: fly auth login

fly launch --no-deploy              # keep the fly.toml in this repo when asked
```

`fly launch` will want to rename the app — let it, then set `app` in `fly.toml`
to the name it chose and `primary_region` to the region closest to the people
you play with. Then:

```sh
fly deploy --ha=false               # without this, Fly starts TWO machines
fly scale count 1                   # the ceiling, to match min_machines_running
fly open
```

Do not skip the `--ha=false`, and do not stop at `fly open` because the app
looks finished. A default `fly deploy` lands you in exactly the split-rooms
state described above, and the game will look fine to you while your friends
are told their code does not exist.

`fly.toml` already turns off the two settings that would otherwise break rooms:
`auto_stop_machines` (Fly stops machines on idle traffic, and a table of
players thinking looks exactly like idle traffic) and `auto_start_machines`.

```sh
fly logs                            # watch a game happen
fly status                          # confirm: one machine, started
```

### Checking the deploy

Replace `<your-domain>` with whatever the platform gave you.

```sh
curl https://<your-domain>/healthz     # twice — the instance id must not change
```

`/healthz` sends `Cache-Control: no-store` so a proxy cannot answer this from
cache; a cached reply would show one id no matter how many machines were live,
which is the opposite of useful. On Fly also run `fly status` and confirm one
machine, started; on Railway check **Settings → Deploy → Replicas: 1**.

Then, from two devices **on cellular, not your wifi** — that is the only way to
prove the websocket survives a real network path:

1. Create a room on one, join by code on the other, play a full game.
2. Watch the browser console for the socket URL — it must be `wss://`. A
   `ws://` on an `https://` page is blocked by the browser outright.
3. Leave one device idle on its turn for two minutes, then play. The server
   pings every 25s to hold the connection open through a long think; if the
   turn goes through, the platform proxy is not timing the socket out.
4. Lock the phone, wait, unlock. It should reconnect to the same seat and hand
   on its own — the client retries with backoff and resumes from a token.

Redeploying restarts the process, which drops every live room. There is no way
around that without a database, so deploy between games.

## The rules, as implemented

Standard rules from [pagat.com](https://www.pagat.com/beating/shithead.html),
no variations. Low to high: `3 4 5 6 7 8 9 10 J Q K A 2`.

- Everyone gets 3 face-down, 3 face-up on top of them, and 3 in hand. The rest
  is the stock. You play what you are dealt — there is no exchange beforehand.
- Play a card of **equal or higher** rank than the top of the pile, or several
  of the **same rank** at once, or **pick up the whole pile** instead.
- After playing from hand, draw back up to 3 while the stock lasts.
- **2 and 10 can be played on anything, and you then play again — it is still
  your turn.** A **10** also burns the pile for good; a **2** does not, it just
  sits on top, and since anything plays on a 2 your follow-up can be anything.
- **Four of a kind burns** the pile, whether played at once or built up across
  turns. The player who completed it goes again.
- You cannot touch your face-up cards while you still hold hand cards. When
  hand, stock and face-up are all gone, you flip your face-down cards blind: if
  the card plays, it stays; if not, you take the pile and the flipped card.
- Clear all your cards and you are out and safe. **The last player still
  holding cards loses.**

Who starts: whoever holds the lowest card **in hand** as dealt. Ties
break on the second-lowest card, then the third, then at random. The card
itself is never revealed — that would give the starter's hand away.

## How it fits together

```
src/shared/   pure rule code. Imported by the server AND, via the /shared/
              static route, by the browser — one copy, so they cannot drift.
src/game/     the engine. No I/O, no clock, no Math.random: the shuffle comes
              from an injected seed, which is what makes it fuzz-testable.
src/server/   http + static files + websockets + rooms.
public/       the client. Native ES modules, no bundler.
test/         node:test. No framework, no config.
tools/        a terminal client, for driving the protocol without a browser.
```

The server is authoritative. It never trusts a card the client sends — it
re-resolves every id against its own state — and a single function
(`src/game/redact.js`) decides what each seat is allowed to see. Your own
face-down cards are never sent to you, only counted; opponents' hands are
counts only; the pile sends its top card and total, never what is underneath.

Scores live in memory for as long as the room does. Close the room and they are
gone — there is no database on purpose.

### The part that was actually hard

Not the websockets. The order of operations inside a single turn.

**Burning the pile and getting another turn are two different things**, and
conflating them is the bug this game invites. A 10 does both. Four of a kind
does both. A 2 grants another turn and *doesn't* burn — it sits on top, and
since anything plays on a 2, the follow-up can be any card at all.

Then the steps have to happen in this order, and no other:

```
1. move the cards onto the pile
2. draw back up to 3        # before the follow-up turn, so a 2 or 10 is played with a full hand
3. burn, if the play burns
4. grant the extra turn
5. out-check               # and if the player is out, CANCEL the extra turn
6. game over, if one player is left holding cards
7. otherwise advance the turn
```

Step 5 is the whole ballgame. If your last card is a 2, you have earned another
turn and you have also just run out of cards — hand the turn over anyway and the
game deadlocks forever on a player with nothing to play. Step 2 sitting above
step 5 matters too: drawing back up can *keep you in the game*, so refilling has
to happen before anyone decides you're out.

I did not get this right by reasoning about it. `test/fuzz.test.js` found it.

## Testing

```sh
npm test                      # everything
FUZZ_SEEDS=5000 npm test      # the full fuzz gate, ~90s
```

`test/fuzz.test.js` plays thousands of random games and checks after *every*
action that all 52 cards are accounted for, that the turn never lands on a
player who is out, and that every game ends with exactly one loser. It is the
test that earns confidence in the turn-resolution ordering.

`test/integration.test.js` boots a real server on an ephemeral port, connects
real websocket clients, and plays whole games from the redacted views alone —
so it proves the protocol, not just the rules. It also audits every frame it
receives for leaked cards, and checks that cheating is refused.

### Playing from a terminal

Useful for poking at the protocol directly. In one shell:

```sh
npm start
```

Then one shell per player:

```sh
node tools/cli-client.js --name Ana --create --players 3
node tools/cli-client.js --name Bob --join K7QM
node tools/cli-client.js --help          # the commands
```

It only ever knows what the server tells it, which is the point: if a game can
be played this way, the data the browser gets is sufficient too.
