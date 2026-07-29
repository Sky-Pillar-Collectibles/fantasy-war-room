# The War Room — Setup

Ten minutes, one time. After this it lives at a URL you can open on your phone, your work laptop, and your desktop, and it costs nothing forever.

---

## What you're putting online

Six files. That is the whole thing.

| File | What it is |
|---|---|
| `index.html` | The page itself |
| `app.js` | All the logic |
| `expert_blend.json` | Your four-source expert rankings (the part I refresh weekly) |
| `market_snapshot.json` | Offline backup of market values, in case the live feed is ever down |
| `manifest.json` | Lets you install it as an app icon on your phone |
| `test_harness.js` | Dev-time tests. Harmless to upload, ignore it. |

No server. No database. No API keys. Nothing to pay for, ever. The page fetches its data directly from public endpoints in your browser when you open it.

---

## Step 1 — GitHub account

Skip if you have one. Otherwise go to **github.com** → Sign up. Free tier is all you need.

## Step 2 — Make the repository

1. Click the **+** in the top right → **New repository**
2. Name it whatever you like — `war-room` is fine
3. Set it to **Public**

   > Public is required for free GitHub Pages. Nothing sensitive is in these files — no passwords, no tokens. Your Sleeper username is typed into the app on your device and stored only in that browser; it never goes into the repo.

4. Leave everything else alone → **Create repository**

## Step 3 — Upload the files

On the new empty repo page, click **uploading an existing file**.

Drag in all six files. Then **Commit changes**.

## Step 4 — Turn on Pages

1. **Settings** tab (top of the repo)
2. **Pages** in the left sidebar
3. Under *Branch*, change **None** → **main**, leave the folder as `/ (root)` → **Save**

Wait about a minute. Refresh the page. GitHub will show your live URL:

```
https://YOUR-USERNAME.github.io/war-room/
```

That's the link. Bookmark it everywhere.

## Step 5 — Sleeper is already connected

Your username (`bobbykelly`) is pre-filled, so the site loads your three 2026 leagues on first open:

| League | Format | Notes |
|---|---|---|
| **DU & Friends** | 12-team superflex **dynasty**, 6-pt pass TD | TE premium (+0.5/rec), no K or DST |
| **PFFP Dynasty League** | 12-team superflex dynasty, 4-pt pass TD | TE premium (+0.5/rec), no K or DST |
| **Rutgers DU Alum** | 12-team **1QB redraft**, 6-pt pass TD | Uses K and DST · **still pre-draft** |

Switch between them from the dropdown at the top. Every ranking, tier, and trade value re-prices for that league's actual scoring, read straight from Sleeper.

Three things this fixes that a single ranking sheet cannot:

- **DU & Friends is a dynasty league**, not redraft. Yesterday's sheet was priced as redraft, which undervalues young players and overvalues aging ones.
- **Both dynasty leagues are TE premium.** No market feed prices that, so TE values there are bumped 18% and the board tells you it's an estimate.
- **Rutgers DU Alum is 1QB, not superflex**, and it's the one that hasn't drafted. Its draft ID is filled in automatically on the Draft tab.

## Step 6 — Put it on your phone's home screen

**iPhone:** open the URL in Safari → Share button → *Add to Home Screen*
**Android:** open in Chrome → ⋮ menu → *Add to Home screen*

It'll launch full-screen with no browser chrome, like a real app.

---

## Where the numbers come from

Two layers, kept deliberately separate so one can't quietly swallow the other.

**Layer 1 — the expert blend.** Published positional rankings from Sports Illustrated, NBC/Rotoworld, Bleacher Report, and ESPN, averaged. These outlets have no API; somebody has to read them. That somebody is now a scheduled task that runs weekly and rewrites `expert_blend.json`.

**Layer 2 — the live market.** FantasyCalc prices every player off thousands of trades actually completed in real leagues, and re-queries for your exact format — superflex, PPR setting, team count, dynasty or redraft. This is the crowd rather than a pundit, and it moves continuously without anyone touching it.

A player's **consensus rank** is the average of their positional rank across every source that covers them. Overall board order is anchored on market value, because it's the only signal that compares a running back to a quarterback honestly.

### The flags that actually save you time

**SPLIT** — the sources disagree unusually widely about this player. That's the tell. Nobody needs six podcasts about Ja'Marr Chase; everyone agrees. The hours were always going into the twenty guys where the smart people genuinely split, and now those twenty are labeled.

**BUY LOW / HYPED** — the analysts and the market disagree about where he belongs. Your league-mates draft off the market, so a player the analysts rate higher than the market does tends to still be sitting there later than his analysis warrants.

**RISING / FALLING** — 30-day movement in what managers are actually paying in real trades.

Open any player to see exactly where each source has him and how wide the range is.

> **On ADP:** no free, browser-accessible source publishes real average draft position. FantasyFootballCalculator blocks cross-origin requests and FantasyCalc's ADP field comes back empty for every player — I checked both from a live browser rather than assuming. So the tool doesn't show an ADP column, because a made-up one is worse than none. The buy-low signal is built from the measured analyst-vs-market gap instead.

---

## Weekly refresh

A scheduled task re-reads the expert sources every Tuesday morning and hands you an updated `expert_blend.json`. To install it: open that file in the repo → pencil icon → paste → **Commit changes**. Roughly fifteen seconds.

The live market layer needs nothing — it's already current every time the page loads.

---

## If something looks wrong

**Setup → Feed Health** lists every source the page pulled and when. Green is live, amber is a cached copy, red is down.

A red feed doesn't break the board. Positional ranks and tiers come from the expert blend and survive on their own; if the market feed is unreachable the page says so plainly at the top and falls back to expert consensus weighted by position. It won't quietly show you stale numbers as if they were fresh.

**Force refresh all feeds** on the same tab clears every cache and re-pulls from scratch.

---

## Draft day

**Draft** tab. Two ways to work:

- **Manual** — tap a player to strike him off. The board re-sorts to best available and the scarcity bars update.
- **Auto-sync** — paste your Sleeper draft ID (the last chunk of `sleeper.com/draft/nfl/XXXXXXXXX`) and hit Sync. It pulls every pick made so far and strikes them all at once. Hit Sync again between picks.

The scarcity bars are the thing to watch. When a position's bar drops below about 25%, the run has started and the next tier is a real cliff.

---

## One honest caveat

None of this predicts the future. What it does is collapse the informed opinion that already exists into one screen, and mark the places where that opinion is genuinely divided rather than merely loud. The confidence it should give you is about *knowing what's known* — not about knowing what happens.

Everything else you were spending Sunday mornings on, you can have back.
