# Playing on a phone

Open the game's link on a phone or tablet and it switches to touch controls by
itself. Hold the phone sideways. Nothing changes on a PC.

The game's text is in Turkish, so the on-screen labels are given here as they
appear, with the English meaning.

## Controls

| On screen | What it does |
|---|---|
| **Left thumb** | A stick appears wherever your thumb lands on the left side. Light push walks (quiet steps), normal push runs, all the way up sprints (the ring says **KOŞU**). |
| **Right thumb** | Drag anywhere on the right half to look around. |
| **Double tap** (right half) | Fires. Keep the second tap pressed to keep firing, and drag it to aim. Tap-tap-tap fires on every tap after the first. A single tap does nothing, and double taps on the stick side don't fire, so re-gripping never shoots. |
| **Big round crosshair button** (fire) | Hold to shoot. Drag it to aim while you're shooting. |
| **NİŞAN** (aim) | Tap for sights / scope, tap again to stop. Sprinting drops it. On the SIFIRYILDIZ it says **PATLAT** and collapses the cores. |
| **Up arrows** (jump) | Jump. While crawling it stands you up. |
| **Down arrow** (crouch) | Tap to crouch, tap again to stand. Hold it to crawl (it says **YÜZÜSTÜ**). |
| **Weapon name** (above the buttons) | Tap for the next gun (empty ones are skipped). Hold it for the full list: tap a gun, or slide your thumb onto one and let go. |
| **KULLAN** (use) | Doors, lifts, switches, secret walls. Not shown in multiplayer, where it does nothing. |
| **SUS** (suppressor) | Shows up with the TÜFEK: suppressor on or off. |
| **+** (medkit) | Shows up when you carry a medkit: use it. |
| **Map icon** (top left) | The map. |
| **❚❚** (top left) | Pause, settings, save. |

## Settings (pause screen)

Remembered on each phone.

- **BAKIŞ HIZI** (look speed): how far a drag turns you.
- **DÜĞMELER** (buttons): KÜÇÜK / NORMAL / BÜYÜK.
- **GRAFİK** (graphics):
  - **ORTA** (medium, the default): the low effects tier, drawn at 1.5x the screen's base resolution.
  - **DÜŞÜK** (low): the same at 1x, a bit softer and the smoothest.
  - **YÜKSEK** (high): the medium effects tier (smoother edges, ambient occlusion, motion blur) at 2x. For recent flagship phones and iPads.

  If a phone can't keep up, the game also lowers the effects on its own, the same way it does on a PC.
- **TAM EKRAN** (full screen, Android), **TİTREŞİM** (vibration, Android: a buzz when you're hit), **SES** (sound).

## Full screen

- **Android**: tapping BAŞLA (or MAÇA KATIL, or DEVAM ET) goes full screen and locks the screen sideways.
- **iPhone**: Safari can't put a web page in full screen. Tap **Share → Add to Home Screen**, then open the game from that icon: it runs without the browser bars. The title screen shows this tip on iPhones.

## Good to know

- Turning the phone upright pauses the game behind a **TELEFONU YAN ÇEVİR** card. Turn it back and it carries on by itself.
- Switching to another app pauses the game. A back swipe in the middle of a game pauses instead of leaving the page. From the title screen, back works normally.
- The screen stays on while you play.
- **Multiplayer**: phones and PCs play in the same match. In the lobby, phones that can share get a **PAYLAŞ** (share) button next to KOPYALA, to send the invite straight to WhatsApp or similar.
- **Loading**: missions 2 and 3, and every multiplayer link, skip about 25 MB of street models that only missions 1 and 4 use. That's most of the download and parsing on a phone. Mission 4 is the heaviest mission; an older phone may struggle with it.

## Trying it on the PC

- Chrome: press F12, then Ctrl+Shift+M (device toolbar), pick a phone and reload. The touch controls come up, and the mouse acts as a finger.
- Add `#touch=1` to the address to force the touch controls on any device, or `#touch=0` to keep them off (for example a tablet with a keyboard). With other settings already in the address, add `&touch=1` instead.
- `npm run check:touch` drives the controls in a headless phone-sized Chrome and checks each one, then checks that the PC version is unchanged (see `scripts/touch-smoke.mjs`). Without a GPU it takes a while.

## For whoever works on the game next

All of it is in `nz-touch.js`. It talks to the game through:

- `padAxis` in `NUKEM.html`: the stick's direction plus walk / sprint. `updatePlayer` reads it instead of WASD while a thumb is on the stick.
- `lookBy(mx, my)` in `NUKEM.html`: the mouse-look code, shared, in mouse counts.
- `NZ.dprCap`: the phone's pixel-ratio ceiling, read by `resize()`.
- `NZ.touch.startTier()`: the phone's starting graphics tier, read by `nz-render.js`.
- It calls the game's own functions by name (`selectWeapon`, `useAction`, `togglePause`, `toggleCrawl` and so on). Renaming one of those means updating `nz-touch.js` too.
- The weapon button shortens the weapon names (`shortName` in `nz-touch.js`): if the names in `WPN` change, check it.

The original files are in `.backup-mobile/`.
