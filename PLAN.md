# Mizan Suite — Plan (next session)

When the user greets you again, remind them of this plan and ask which item to start.

## State (all done & shipped)
- Landing page live on Render: retail-generic copy, two-tier pricing (Basic 35 000 DA / PRO 60 000 DA), screenshots mapped correctly, gallery lightbox (swipe / arrows / pinch-zoom / double-tap), Instagram @mizansuite added.
- App fixes shipped (theme, focus-fix, entity decode, generic wording EN/FR/AR) — installer rebuilt + release asset re-uploaded.
- 109/109 tests pass (one flaky boot-race in test-api-license.js passes in isolation). Backup task verified working (H:\MizanSuiteBackup).
- Old install cleaned from C:\Program Files.

## Status (all done)
1. ✅ Money path verified end-to-end (submit -> sign -> email -> activate, tested with real key on this PC).
2. ✅ Signer task confirmed running every 5 min (last result 0).
3. ✅ App reinstalled on this PC with latest build (retail wording live in asar).
4. ❌ Code-signing certificate SKIPPED (user won't pay). Note: unsigned installer will trigger SmartScreen/"Unknown Publisher" and occasional AV flags on client PCs. Accept it or revisit later.
5. Optional: make trial queue durable — move queue.json (ephemeral on Render free tier, wiped on redeploy) to free Postgres/Upstash. Low risk now; do only if wanted.
6. ✅ Basic/PRO tier system implemented in code (NOT yet shipped: needs npm test, installer rebuild, release upload, on-PC verify):
   - `tier` field in license payload: `basic` | `pro`, missing tier = `pro` (all old keys + trials stay PRO).
   - Trial keys signed `tier:'pro'`. Manual issuance (License Dashboard + generate-license.js) has a tier selector, default PRO.
   - Basic = Encaissement, Inventaire, Stock, Étiquettes, Remboursements. PRO = everything else (Achats, Péremption, Réapprovisionnement, Dettes, Clients/fidélité, Facturation, Finances, Rapports, Statistiques).
   - Frontend gates: auth.js redirects Basic off PRO pages, sidebar hides PRO links, dashboard shows locked PRO tiles (click → upgrade nudge to Settings), Settings shows edition + Basic→PRO upgrade box (kept even for permanent Basic).

## Remaining / next ideas
- Ship the tier build: run `npm test`, rebuild installer, re-upload release asset, reinstall on this PC, verify Basic vs PRO gating with a basic key.
- Marketing: plan Instagram content (@mizansuite) to start generating trial signups.
- Optional: durable trial queue on Render (only if signups become frequent).

## Deferred (user decided)
- Payment methods: keep free/offline order (email/Instagram) until profit justifies investment.
- Verticals (restaurant/café/supermarket as one build + config profiles).
- Note: frontend tier gating is client-side (page redirect + hidden links). Server APIs are NOT tier-checked; acceptable for a single-PC offline POS, revisit only if clients are multi-PC.

## Things to be careful about
- Render free tier: queue.json is wiped on every deploy -> pending trial requests can be lost (small window, low impact now).
- Installed app won't show new strings until reinstalled.
- A Basic key re-issued/renewed via License Dashboard: renew keeps existing tier; changing tier requires issuing a new key.
- trial/public/index.html pricing no longer has the launch countdown (removed with two-tier cards).
