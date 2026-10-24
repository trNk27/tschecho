# Ember

A 1–4 player co-op survival game for game night. Phones are the controllers, one laptop shows a split-screen 3D view, and a tiny Node server connects them by room code. Keep the shared campfire burning until dawn of the last night.

- **Laptop** (`/`): lobby with room code and QR code, then the game. It runs the whole simulation and renders one viewport per player.
- **Phone** (`/play?room=ABCD`): floating joystick, buttons A/B/C, health/hunger and context hints.
- **Server**: serves both pages, `/healthz`, and the `/ws` room relay. It never runs game logic.

## How to play

| | |
| --- | --- |
| **Day (2 min)** | Spread out and gather. Hold **A** to chop trees or mine rocks, tap **A** to pick berries or pick up piles. You carry one stack at a time. |
| **B** | Next to the fire: throw your wood or gas in. With berries or canned food: eat one. Otherwise: drop your stack (teammates can pick it up). |
| **C** | 2 wood → torch (light radius, lasts until the next dawn). 3 stone → wall segment (blocks creatures and zombies until they break it). |
| **Dusk (20 s)** | Red sky and a warning: get back to the fire. |
| **Night (90 s)** | Shadow creatures come out of the dark. They will not enter the light of the fire or a torch (the glowing ring on the ground), but attack anyone outside it. A zombie horde also marches from the city to the camp; zombies are not afraid of light and stamp out the fire if they reach it. Tap **A** to fight. |
| **Downed** | A teammate holds **A** next to you for 3 seconds to revive you. |

The run is lost when the fire goes out or everyone is downed, and won at dawn of the last night (3 or 5 nights, chosen in the lobby; 5 nights take about 19 minutes). Each run gets a new island.

**The camera** sits behind each player and looks ahead. The joystick is relative to it (up = forward); when you walk sideways the camera slowly swings round behind you, and it pulls in when a building stands behind you.

**The first three days are an easy introduction.** Day 1 is longer (2½ min), night 1 has no zombie horde and only a creature or two, enemies hit softer and notice you later, the fire burns slower and hunger drops slower. Goals at the top of the screen (and on the phones) walk the team through every mechanic: chopping, feeding the fire, eating, torches, mining, walls, searching cars, weapons and gas cans. If everyone is downed during the first three nights you wake up by the fire (it costs some fuel) instead of losing. From night 4 the full difficulty kicks in and keeps rising.

### The abandoned city

One side of every island holds a ruined city: 16 blocks of streets, wrecked cars, dumpsters, debris, collapsed buildings and zombies. Walk up to a car or dumpster and hold **A** to search it (each can be searched once a day; some refill at dawn). The city has three districts, shown on your phone and screen when you enter them:

| District | Zombies | Typical loot |
| --- | --- | --- |
| **Outskirts** (the blocks facing the camp, houses and parks) | few | canned food, baseball bat, leather jacket, planks, some gas |
| **Midtown** | more | gas cans, machete, ammo, the odd pistol |
| **Downtown** (the four central blocks, tall towers) | swarming | gas cans, pistols, ammo, riot armour |

Gear has its own slots (it does not take up your carried stack). Tap **A** on a loot bag to take it; your old item is dropped.

| Gear | Effect |
| --- | --- |
| Fists | 1 damage |
| Baseball bat 🏏 | 2 damage |
| Machete 🔪 | 3 damage, faster swings |
| Pistol 🔫 | 3 damage at up to 11 units, auto-aims; comes with 12 rounds, ammo boxes add 10. Gunshots attract zombies nearby. Out of ammo it is just a club. |
| Leather jacket 🧥 | −30 % damage taken |
| Riot armour 🦺 | −55 % damage taken |
| Gas can ⛽ (carried) | +22 fuel each when poured on the fire |
| Canned food 🥫 (carried) | +45 hunger |

After the easy first three days, difficulty rises every night: more and faster shadow creatures, a bigger zombie horde, tougher zombies, faster fuel drain, and the city refills with more zombies each dawn. All of it also scales with the number of players. Each player carries a small lantern at night, so dark streets stay readable (it does not scare anything away).

## Run it locally

Requires Node 20+.

```bash
npm install
npm run dev        # relay on :8080 + Vite on :5173 (open http://localhost:5173)
```

Or the production build, exactly as Render runs it:

```bash
npm run build
npm start          # http://localhost:8080
```

Phones on the same Wi-Fi can join via the laptop's LAN address (the QR code uses whatever address the laptop page was opened with). Fullscreen and wake lock need HTTPS, so on plain `http://` LAN addresses they are skipped; everything else works.

```bash
npm test           # simulation + room server tests
npm run typecheck
```

Press **F** on the laptop to show frame rate, draw calls and render resolution.

## Deploy to Render

The repo contains a `render.yaml` Blueprint (New → Blueprint → pick this repo), or create a Web Service by hand:

- Runtime: Node 22 (20+ works)
- Build command: `npm ci --include=dev && npm run build`
- Start command: `node server/dist/index.js` (listens on `PORT`)
- Health check path: `/healthz`

The WebSocket runs on the same URL (`/ws`), so there is no extra service or CORS setup. Only the service's own domain may open the WebSocket; add other origins (for example a custom domain) as a comma-separated `ALLOWED_ORIGINS` environment variable.

On the free plan the service sleeps after 15 minutes without traffic and takes about a minute to wake up: open the laptop page a minute before everyone arrives. During play the phones' 100 ms heartbeat keeps it awake. Rooms live in memory, so a Render restart ends the current game.

## Performance

Built for an average laptop:

- Pixel ratio capped at 1 (0.75 on the **Low** graphics setting, which also turns off antialiasing). If the frame rate drops below about 50 fps (1–2 players) or 38 fps (3–4 players), the render resolution steps down automatically and back up when there is headroom.
- Low-poly flat-shaded art without textures; trees, rocks, bushes, grass, buildings, roofs, cars, dumpsters, debris, creatures, zombies (body, legs, eyes), torches, walls, loot and dropped items are each one `InstancedMesh` draw call. Building windows are drawn by the shader, not with geometry or textures. About 50 draw calls per viewport.
- Fog with a 64-unit camera far plane, terrain split into chunks for frustum culling.
- No real-time shadows (blob shadows instead); a fixed pool of 8 point lights (the fire, plus player lanterns at night and the nearest torches, re-assigned per viewport) so shaders never recompile.
- Tall buildings and trees between the camera and a player are dithered away in the shader instead of moving the camera.
- The simulation runs on a fixed 30 Hz tick, independent of rendering; positions are interpolated for smooth movement at any frame rate.

## Robustness and security

- Every message is validated with zod schemas; payloads are capped at 1 KB; each socket is rate-limited (60 msg/s for phones), and sockets that keep sending junk or flooding are closed.
- Only a room's host socket may send host messages; a phone's slot always comes from its server-side session, never from the message. The laptop clamps joystick input again.
- Room codes use `crypto.randomInt` and letters without look-alikes; tokens use `crypto.randomUUID()` and are compared in constant time.
- The WebSocket upgrade checks the `Origin` header. HTTP requests behind Render's proxy are redirected to HTTPS.
- Names are trimmed to 12 characters and always rendered with `textContent`.
- Reconnects: a phone that reloads or loses its connection rejoins its old slot automatically (backoff 0.5 s → 5 s); its character stands still meanwhile. If the laptop reloads, the room stays alive for 60 s and the game continues from a snapshot. Empty rooms expire after 10 minutes, at most 50 rooms exist at once, and dead sockets are detected with a ping every 20 s.
- No accounts and no stored personal data.

## Phones

- **Android Chrome**: "Join" enters fullscreen and locks landscape. After a reload, tap once to go fullscreen again.
- **iPhone Safari**: the Fullscreen API is not available for web pages. The controller works with the Safari bars visible; for fullscreen use *Share → Add to Home Screen* and open Ember from there. A "rotate your phone" overlay appears in portrait. iPhones do not vibrate, so every haptic also flashes the screen.
- The screen stays on via the Wake Lock API where supported.

## Project layout

```
shared/constants.ts     values shared by all three parts (no zod, safe for browsers)
shared/protocol.ts      message types + zod schemas
server/index.ts         HTTP static files, /healthz, WebSocket upgrade, ping
server/rooms.ts         rooms, slots, reconnect tokens, routing, rate limits
client/common/socket.ts reconnecting WebSocket
client/host/            laptop page: lobby, QR code, HUD
client/host/game/       island + city generation, simulation (incl. zombies and gear), Three.js renderer, models, audio
client/controller/      phone page: join form, joystick, buttons
tests/                  node:test suites for the simulation and the room server
```
