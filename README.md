# Comps-Fit Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/BGBug22/token-radar-01-v8/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/BGBug22/token-radar-01-v8/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Every pre-token protocol in the sealed DefiLlama snapshot, priced off the traded
market — not off a flat multiple. The comps curve is fit on the 128 traded
tokens in the snapshot and tested out of sample; each row shows its maths, a
peer listing-rate, and a costed farm plan with a FARM / THIN / SKIP verdict.

## The model

```
implied value = comps × peer rate × growth tilt × maturity tilt
comps         = 10 ^ (3.0247 + 0.5223 × log10 TVL)
peer rate     = share of protocols in the same TVL band that already list a token
growth tilt   = 1 + clamp(7-day change, −60, +120) ÷ 100 × 0.25
maturity tilt = 0.9 + min(age in days, 1095) ÷ 1095 × 0.2
```

Out-of-sample test (split-half, median error): fitted curve ×2.91 and ×3.92
against a flat multiple's ×4.89 and ×6.06. A category tilt was tested and
dropped — it changed neither split-half median. Growth and no-token age do not
move the traded multiple in-sample (R² 0.02 and 0.00), so they enter as bounded
tilts, stated as tilts, not as fitted coefficients.

## Run it

```sh
node main.ts --input <snapshot.json>
```

Reads the sealed snapshot, writes `board.json` (198 ranked rows: the 40
watchlist protocols plus every other rankable pre-token protocol), the
dashboard data, the dashboard, the screenshots and `dossier.json` into
`/output` (or `$MAKEFUN_OUTPUT_DIR`). Node 22, standard library only.

## The board

- 758 protocols in the snapshot, 40 on the watchlist, 198 ranked rows.
- A protocol counts as pre-token when DefiLlama's record carries no token for
  it. Wrapped, staked, bridged and exchange products are excluded by the
  house's own rule — each is a product of a token that already trades.
- Farm verdict from implied value alone: FARM at $25M or more, THIN at
  $5M–$25M, SKIP below $5M. Farming costs $28 of gas for 12 weeks; the
  capital is returned, the gas is not.
- Tokens that already trade are shown separately, at market value, never ranked.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bgbug-22&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
