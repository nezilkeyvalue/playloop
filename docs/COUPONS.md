# Coupons

How a discount code gets from a merchant's spreadsheet into a player's
clipboard, and why each step is where it is.

Referenced from `lib/engine/types.ts` (`CouponTerms`) and CLAUDE.md.

---

## 1. The one thing to understand first

A coupon is split in half, and the halves live in different places:

| Half | Lives in | Who can see it |
|---|---|---|
| **Terms** — T&C text, expiry date, offer link (`CouponTerms`) | `GameSpec.rewards[i].coupon` | everyone |
| **Codes** — the actual strings | the `coupons` table | one player gets exactly one |

`GameSpec` is delivered *wholesale* to every third-party storefront running
the embed. Anything in it is public. So the terms — which players are entitled
to read before claiming — ride along in the spec and render with no extra
network request, while the codes never leave the server except one at a time.

> **Never put codes in `GameSpec`.** A pool in the spec is a pool published to
> anyone who opens devtools on a storefront running the embed.

Pools are **per reward tier**, not per game, because `RewardTier` already
models different offers per score band (a 30%-off tier should hand out
different codes than a 10%-off tier).

---

## 2. Admin: stocking a pool

In the editor (`/games/:id`), each reward tier with a discount
(`percentOff != null`) gets a **Coupon codes** panel
(`components/CouponManager.tsx`). A thank-you tier (`percentOff: null`) gets
none — the runtime renders no code block for it, so offering an inventory
would promise a handover that never happens.

### 2a. Terms

Three fields — T&C text, expiry, offer link — saved through the **same**
`PATCH /api/games/:id` the rest of the editor uses, validated by
`validateCouponTerms()` in `lib/engine/specRules.ts`:

- terms capped at 600 characters (players read this on a phone)
- expiry is a **date only** (`YYYY-MM-DD`); a timezone-bearing datetime
  invites "expired a day early" bugs
- offer link must be `https` — the embed runs on https storefronts, so an
  `http` link is a mixed-content warning at best

### 2b. Codes — three ways in

All three funnel through `normalizeCodeBatch()` so a paste and a spreadsheet
get identical cleaning (uppercased, whitespace stripped, de-duplicated,
junk rejected).

**Generate** — `lib/coupons/codes.ts`. Crypto-random (`getRandomValues`, not
`Math.random`: these are bearer tokens for money off, and a predictable PRNG
lets someone who has seen a few codes derive the batch). The alphabet excludes
every vowel — so a random 8-character string can't spell something
unfortunate — and `0 O 1 I L`, the characters people get wrong when typing a
code off a phone screen.

**Upload `.csv` / `.xlsx`** — `lib/coupons/parse.ts`. CSV is parsed here with
no dependency (quoted fields, escaped quotes, BOM, CRLF); XLSX goes through
`exceljs`.

The important part is **column detection**. Real merchant exports are wide:

```
Type,Discount code,Value,Times used
fixed,"WELCOME,5",5,0
percent,SPRING15,15,2
```

Taking column 0 imports `Type`. So the column is *found by header name*
(`Discount code`, `Coupon code`, `Promo code`, `Code`, …) and only falls back
to the first column when nothing is recognised. The response echoes which
column was read, because importing the wrong column is the failure nobody
notices.

`.xls` (pre-2007 binary) is rejected outright rather than mis-parsed — that
would surface as "0 codes imported" with no explanation.

**Paste a list** — split on any whitespace/comma/semicolon.

### 2c. Re-uploading is safe

A code is unique per game (`coupons_game_code_idx`). Uploading the same file
twice reports the overlap as duplicates instead of double-issuing, so
uploading a *superset* of a previous file tops the pool up.

---

## 3. Player: earning and claiming

```
                      ┌─ player presses "Copy my code" ─┐
POST /plays/start     │                                 │
   ↓ sessionToken     │   POST /plays/claim-coupon      │
 [ plays the game ]   │      ↓                          │
   ↓                  │   claim_coupon() SQL fn         │
POST /plays/finish ───┘      ↓ one code                 │
   ↓ tier, no code        clipboard ←───────────────────┘
 reward screen
```

### Step 0 — the reward has to be earned

No tier may sit at `minScore: 0` (`REWARD_MIN_SCORE_FLOOR` in
`lib/engine/specRules.ts`, enforced by `validateRewardTier` and therefore by
both `PATCH /api/games/:id` and `brain.ts`). A tier at 0 pays out to a player
who loaded the embed and let the clock run down — the merchant funds a
discount for no engagement, and the pool drains to people who never played.

So **finishing below every threshold is an ordinary outcome**, not an edge
case. `resolveReward()` returns `tierIndex: -1` for it and the reward screen
renders `renderNearMissBlock()` instead of a coupon block: the gap in points,
the tier that closes it, a progress bar, and **Play again** promoted to the
primary button. Lead capture is hidden on that screen — "Email it to me"
with no code behind it is a promise nothing can keep.

`brain.ts` pitches the entry tier at 15% of the template's
`scoring.maxRealistic` (`defaultRewardLadder()`), and the Gemini prompt asks
for the same. A model-proposed tier at 0 is dropped, not repaired.

### Step 1 — the round ends

`mount.ts` paints the reward screen immediately (without waiting on the
network) and calls `POST /api/plays/finish`. `finishPlay()` vets the reported
score against the template's realistic ceiling and an elapsed-time floor, then
stores the verdict.

**`finish` returns no code for a pooled tier.** It used to mint a random
string when a tier had none; see §5.

### Step 2 — the screen shows a button, not a code

`renderCouponBlock()` renders **Copy my code** with the code area hidden and
*no* request made. Nothing is consumed yet — this is the whole reason claiming
is separate from finishing. A player who reaches the end screen and closes the
tab costs the merchant nothing.

### Step 3 — the player presses the button

`POST /api/plays/claim-coupon { sessionToken }` →
`claimCouponForPlay()`, which:

1. requires the play to be **finished** (409 otherwise) — claiming before the
   score is vetted would let someone skip playing;
2. reads `play.tierIndex` for the tier. **Not** `play.score` — see §5;
3. maps that *sorted* index to the spec's *array* index — see §5;
4. refuses if the offer has expired, even when codes remain (otherwise the
   pool keeps handing out codes the merchant's checkout will reject);
5. calls the `claim_coupon()` SQL function.

### Step 4 — the code is copied

The client writes it to the clipboard (`navigator.clipboard`, falling back to
a hidden textarea + `execCommand` — the Clipboard API needs a secure origin
and a focused document, neither guaranteed inside an iframe on someone else's
site), then reveals the code, the terms, the expiry and the offer link.

If the clipboard write fails the code is still shown, with "Select the code
above to copy it."

---

## 4. Why claiming is a SQL function

```sql
update coupons set claimed_at = now(), claimed_by_play_id = p_play_id
 where id = (select id from coupons
              where game_id = ... and tier_index = ... and claimed_at is null
              order by created_at limit 1
              for update skip locked)
returning code
```

Between "find the oldest unclaimed row" and "mark it mine", a concurrent
player reads the *same* row and both walk away with the same code. A
read-then-write in TypeScript cannot fix this; `FOR UPDATE SKIP LOCKED` can —
each concurrent caller locks a different row and nobody waits.

Verified: 8 simultaneous claims against a 5-code pool → **5 distinct codes,
3 told exhausted**.

**Idempotency** is the same function's first act: if this play already holds a
code for this tier, return it and consume nothing. So a double-clicked button
is free. That is backed by a unique index
(`coupons_one_per_play_idx`), not by caller discipline — two requests racing
past the check still cannot both insert, and the loser reads the winner's code
back out.

This is also what makes `telemetry.ts`'s automatic retry safe: a retried claim
cannot double-spend.

---

## 5. Three traps, all of which were live bugs

**Never re-derive the tier from `plays.score`.** `finishPlay` keeps the *raw*
reported score for audit even when it judges a play forged — it signals the
rejection with `tier_index = null`, not by zeroing the score. Resolving the
tier from `score` therefore pays out exactly the plays that were just
rejected. Read `play.tierIndex`; null means "earned nothing".

**`plays.tier_index` is not an index into `spec.rewards`.** `finishPlay`
sorts the tiers by `minScore` and records the winner's position in the
*sorted* list; pools are keyed by position in the array the merchant edits.
For `[{min:0},{min:50}]` they agree; for `[{min:50},{min:0}]` they are
swapped — and reordering tiers in the editor is enough to trigger it. Convert
with `originalTierIndexFromSortedIndex()`.

**Never invent a code.** `finishPlay` used to do
`tier.code ?? generateRewardCode()`. A generated code exists nowhere in the
merchant's store, so the player carries it to checkout and it is rejected —
and because the reward screen seeded its block from that value, a game *with*
a real pool displayed the fake code instead of claiming a real one.

---

## 6. When there is nothing to give

| Situation | `status` | Player sees |
|---|---|---|
| Pool ran out | `exhausted` | tier + "No codes left right now — check back soon." |
| Offer past its expiry | `expired` | same |
| Tier never had a pool | `no_reward` | same |
| Score cleared no tier | `no_reward` | just the score + product recap |

All of these are **HTTP 200** with a status string, not errors — an empty pool
is a normal state of a live campaign, not a network failure to retry.

The deliberate choice is to show the tier **without** a code rather than
generate a fallback: a fabricated code fails at the merchant's checkout, which
is worse for the player than being told to check back.

The editor warns on low stock (≤10 remaining) and on exhaustion, and that
warning stays visible while the panel is collapsed — an exhausted pool
silently stops paying out, so it must not be hidden behind a disclosure.

---

## 7. Files

| File | Role |
|---|---|
| `lib/engine/types.ts` | `CouponTerms`, `CouponRecord`, `CouponTierStats` |
| `lib/engine/specRules.ts` | terms validation, expiry check, tier-index mapping |
| `lib/engine/specPatch.ts` | accepts `coupon` on a reward-tier patch |
| `lib/coupons/codes.ts` | generation + batch canonicalisation |
| `lib/coupons/parse.ts` | CSV/XLSX → raw codes, column detection |
| `lib/db/queries.ts` | `addCoupons`, `getCouponStats`, `claimCouponForPlay`, … |
| `supabase/migrations/*_coupons.sql` | table, indexes, RLS, `claim_coupon()` |
| `app/api/games/[id]/coupons/route.ts` | owner-only admin (GET/POST/DELETE) |
| `app/api/plays/claim-coupon/route.ts` | public, one code per play |
| `components/CouponManager.tsx` | per-tier admin panel |
| `lib/runtime/mount.ts` | `renderCouponBlock()` — the Copy button |

Claimed rows are **never deleted** (clearing a pool removes only unclaimed
ones): they record which code went to which play, which is what a merchant
needs when a customer disputes a code at checkout.
