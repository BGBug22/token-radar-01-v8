// Comps-fit token radar: a fitted launch-pricing model over the sealed snapshot.
//
// The model is fit at runtime from the snapshot itself, never from a list of
// names. Traded tokens (128 protocols with a market cap) pin the comps curve;
// every pre-token protocol is then priced off that curve, a peer listing-rate
// and two bounded tilts. The fit is re-checked on every run: the constants
// below are the fit's own numbers for this frozen snapshot, and the program
// refuses to run if a re-fit disagrees with them.
//
//   log10(market cap) = FIT_A + FIT_B * log10(TVL)
//   comps             = 10 ^ (FIT_A + FIT_B * log10(TVL))
//   peer              = share of protocols in the same TVL band that already
//                       list a token (a peer listing-rate, five bands)
//   growth tilt       = 1 + clamp(change_7d, -60, +120) / 100 * 0.25
//   maturity tilt     = 0.9 + min(age_days, 1095) / 1095 * 0.2
//   implied value     = round(comps * peer * growth tilt * maturity tilt)
//
// What the fit actually says, on this snapshot (shown on the dashboard too):
//   fit n=128, R^2 0.194, in-sample median |error| 0.527 in log10 (about x3.4)
//   split-half A->B median error x2.91, flat multiple x4.89
//   split-half B->A median error x3.92, flat multiple x6.06
//   a category tilt was tested and dropped: it changed neither split-half
//   median. Growth and no-token age do not move the traded multiple
//   in-sample (R^2 0.02 and 0.00), so they enter as bounded tilts, stated
//   as tilts, not as fitted coefficients.

/** One protocol as the sealed snapshot carries it: exactly ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The fitted comps curve and how well it held up out of sample. */
export interface FitStats {
  n: number;
  intercept: number;
  slope: number;
  r2: number;
  median_abs_log_err: number;
  split_half_a: { median_abs_log_err: number; flat_median_abs_log_err: number };
  split_half_b: { median_abs_log_err: number; flat_median_abs_log_err: number };
  flat_multiple: number;
}

/** One TVL band's peer listing-rate. */
export interface PeerBand {
  low_usd: number;
  high_usd: number | null;
  protocols: number;
  with_token: number;
  rate: number;
}

/** A farm verdict: what the numbers say to do, and why. */
export type Verdict = 'FARM' | 'THIN' | 'SKIP';

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  comps_value_usd: number;
  peer_rate: number;
  growth_tilt: number;
  maturity_tilt: number;
  verdict: Verdict;
  verdict_reason: string;
  farm_capital_usd: number;
  farm_cost_12w_usd: number;
  hold_days: number;
  farm_steps: string[];
}

/** One board row, compact, for the dashboard's data.js. */
export type RadarRow = BoardRow;

/** A protocol whose token already trades: market value only, never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  mcap_per_tvl: number;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  fit: FitStats;
  peer_bands: PeerBand[];
  protocols_total: number;
  watchlist_size: number;
  board_size: number;
  traded_fitted: number;
  verdict_counts: { FARM: number; THIN: number; SKIP: number };
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// --- The fitted curve: this snapshot's own numbers, re-checked at runtime. ---
export const FIT_INTERCEPT = 3.0247;
export const FIT_SLOPE = 0.5223;
export const FIT_TOLERANCE = 0.002;
export const MODEL_VERSION = 'comps-fit-1';

// --- Tilts and verdicts: stated bounds, not fitted coefficients. ---
export const GROWTH_WEIGHT = 0.25;
export const GROWTH_FLOOR = -60;
export const GROWTH_CAP = 120;
export const MATURITY_FLOOR = 0.9;
export const MATURITY_RANGE = 0.2;
export const MATURITY_DAYS = 1095;
export const UNKNOWN_AGE_DAYS = 365;
export const FARM_THRESHOLD_USD = 25_000_000;
export const THIN_THRESHOLD_USD = 5_000_000;
export const GAS_SETUP_USD = 4;
export const GAS_WEEKLY_USD = 2;
export const FARM_WEEKS = 12;
export const LIVE_ROWS = 24;

const DAY_MS = 86_400_000;
const LOG10 = Math.log10;

/** The house's own watchlist rule, applied to every board row, not just the watchlist. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether DefiLlama's record carries no token at all for this protocol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is a wrapped, staked, bridged or exchange product of a token that trades. */
export function isExcludedProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return true;
  if (VERSIONED_NAME.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  return EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix));
}

/** Whether the board may rank this protocol: pre-token and no excluded product. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !isExcludedProduct(p);
}

/** The traded protocols the curve is fit on: a token and a market cap, both positive. */
export function tradedSet(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
}

interface Ols {
  intercept: number;
  slope: number;
}

/** Ordinary least squares on log10(market cap) against log10(TVL). */
function ols(rows: SnapshotProtocol[]): Ols {
  const xs = rows.map((p) => LOG10(p.tvl_usd));
  const ys = rows.map((p) => LOG10(p.mcap_usd!));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const slope = den === 0 ? 0 : num / den;
  return { intercept: my - slope * mx, slope };
}

/** Median absolute log10 error of a fitted curve on a set of traded protocols. */
function medianAbsLogErr(rows: SnapshotProtocol[], fit: Ols): number {
  const errs = rows
    .map((p) => Math.abs(LOG10(p.mcap_usd!) - (fit.intercept + fit.slope * LOG10(p.tvl_usd))))
    .sort((a, b) => a - b);
  const mid = Math.floor(errs.length / 2);
  return errs.length % 2 === 1 ? errs[mid]! : (errs[mid - 1]! + errs[mid]!) / 2;
}

/** Fit the comps curve and its out-of-sample record, from the snapshot itself. */
export function fitComps(snapshot: Snapshot): FitStats {
  const traded = [...tradedSet(snapshot)].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  if (traded.length < 20) throw new SnapshotError(`only ${traded.length} traded tokens to fit on`);
  const fit = ols(traded);
  const ys = traded.map((p) => LOG10(p.mcap_usd!));
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let ssRes = 0;
  let ssTot = 0;
  for (const p of traded) {
    const r = LOG10(p.mcap_usd!) - (fit.intercept + fit.slope * LOG10(p.tvl_usd));
    ssRes += r * r;
    ssTot += (LOG10(p.mcap_usd!) - my) ** 2;
  }
  const flatMultiple =
    traded.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b)[Math.floor(traded.length / 2)]!;
  const flatErr = (rows: SnapshotProtocol[]): number => {
    const errs = rows
      .map((p) => Math.abs(LOG10(p.mcap_usd!) - LOG10(flatMultiple * p.tvl_usd)))
      .sort((a, b) => a - b);
    const mid = Math.floor(errs.length / 2);
    return errs.length % 2 === 1 ? errs[mid]! : (errs[mid - 1]! + errs[mid]!) / 2;
  };
  const half = Math.floor(traded.length / 2);
  const first = traded.slice(0, half);
  const second = traded.slice(half);
  const fitFirst = ols(first);
  const fitSecond = ols(second);
  return {
    n: traded.length,
    intercept: Math.round(fit.intercept * 1e4) / 1e4,
    slope: Math.round(fit.slope * 1e4) / 1e4,
    r2: Math.round((1 - ssRes / ssTot) * 1e4) / 1e4,
    median_abs_log_err: Math.round(medianAbsLogErr(traded, fit) * 1e3) / 1e3,
    split_half_a: {
      median_abs_log_err: Math.round(medianAbsLogErr(second, fitFirst) * 1e3) / 1e3,
      flat_median_abs_log_err: Math.round(flatErr(second) * 1e3) / 1e3,
    },
    split_half_b: {
      median_abs_log_err: Math.round(medianAbsLogErr(first, fitSecond) * 1e3) / 1e3,
      flat_median_abs_log_err: Math.round(flatErr(first) * 1e3) / 1e3,
    },
    flat_multiple: Math.round(flatMultiple * 1e4) / 1e4,
  };
}

/** Five TVL bands; each band's peer listing-rate is the share of its protocols that already list a token. */
export function peerBands(snapshot: Snapshot): PeerBand[] {
  const edges: Array<[number, number | null]> = [
    [5_000_000, 50_000_000],
    [50_000_000, 250_000_000],
    [250_000_000, 1_000_000_000],
    [1_000_000_000, 5_000_000_000],
    [5_000_000_000, null],
  ];
  return edges.map(([low, high]) => {
    const inBand = snapshot.protocols.filter((p) => p.tvl_usd >= low && (high === null || p.tvl_usd < high));
    const withToken = inBand.filter((p) => !isPreToken(p)).length;
    return {
      low_usd: low,
      high_usd: high,
      protocols: inBand.length,
      with_token: withToken,
      rate: inBand.length === 0 ? 0 : Math.round((withToken / inBand.length) * 1000) / 1000,
    };
  });
}

/** The peer listing-rate for one TVL, from the band it falls in. */
export function peerRateFor(tvlUsd: number, bands: PeerBand[]): number {
  for (const b of bands) {
    if (tvlUsd >= b.low_usd && (b.high_usd === null || tvlUsd < b.high_usd)) return b.rate;
  }
  return bands[bands.length - 1]!.rate;
}

/** The comps value: what the fitted curve says a token on this TVL would be worth. */
export function compsValue(tvlUsd: number): number {
  return Math.max(1, Math.round(10 ** (FIT_INTERCEPT + FIT_SLOPE * LOG10(tvlUsd))));
}

/** The growth tilt: bounded, and stated as a tilt because growth does not move the traded multiple in-sample. */
export function growthTilt(change7d: number | null): number {
  const g = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, finite(change7d, 0)));
  return Math.round((1 + (g / 100) * GROWTH_WEIGHT) * 1e4) / 1e4;
}

/** The maturity tilt: longer with no token, a little more; bounded 0.9 to 1.1. */
export function maturityTilt(age: number | null): number {
  const days = age ?? UNKNOWN_AGE_DAYS;
  return Math.round((MATURITY_FLOOR + (Math.min(Math.max(days, 0), MATURITY_DAYS) / MATURITY_DAYS) * MATURITY_RANGE) * 1e4) / 1e4;
}

/** The farm capital for one position, from the protocol's own TVL. */
export function capitalFor(tvlUsd: number): number {
  if (tvlUsd >= 5_000_000_000) return 250;
  if (tvlUsd >= 1_000_000_000) return 150;
  if (tvlUsd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The verdict from the implied value alone, with its reason in plain words. */
export function verdictFor(impliedUsd: number, cost12wUsd: number): { verdict: Verdict; reason: string } {
  if (impliedUsd >= FARM_THRESHOLD_USD) {
    return {
      verdict: 'FARM',
      reason: `Implied $${Math.round(impliedUsd / 1_000_000)}M against $${cost12wUsd} to farm for 12 weeks: farm it.`,
    };
  }
  if (impliedUsd >= THIN_THRESHOLD_USD) {
    return {
      verdict: 'THIN',
      reason: `Implied $${Math.round(impliedUsd / 1_000_000)}M against $${cost12wUsd} to farm for 12 weeks: a thin position only.`,
    };
  }
  return {
    verdict: 'SKIP',
    reason: `Implied $${Math.round(impliedUsd / 1_000_000)}M is too small against $${cost12wUsd} to farm for 12 weeks: skip it.`,
  };
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** One farm step: action, cost, time — each step one string the gate can check. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: action, then cost and time, inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The category's one action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Lend $${capital} of USDC into ${name}'s lending market on ${chain} and leave the deposit earning.`;
  }
  if (c.includes('dex') || c.includes('leveraged farm')) {
    return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} in a balanced pair and keep the LP position.`;
  }
  if (c.includes('yield')) {
    return `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and keep the shares.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC into ${chain} through ${name}, then put the bridged funds to work in its app.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of the chain's native asset through ${name} and hold the receipt token.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return `Deposit $${capital} of USDC as collateral on ${name} and open one small hedged position.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} and take one small position on a ${name} market.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * Every figure comes from the protocol's own record (category, chains, TVL,
 * age); no protocol name is ever special-cased.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 8 : 4;
  return [
    {
      text: 'Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: 'Do one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
      cost: `about $${GAS_WEEKLY_USD} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.",
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** Score one protocol under the fitted model. */
export function scoreProtocol(
  p: SnapshotProtocol,
  asOf: string,
  bands: PeerBand[],
): Omit<BoardRow, 'rank'> {
  const age = ageDays(asOf, p.listed_at);
  const comps = compsValue(p.tvl_usd);
  const peer = peerRateFor(p.tvl_usd, bands);
  const gTilt = growthTilt(p.change_7d);
  const mTilt = maturityTilt(age);
  const implied = Math.max(1, Math.round(comps * peer * gTilt * mTilt));
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const cost12w = GAS_SETUP_USD + FARM_WEEKS * GAS_WEEKLY_USD;
  const { verdict, reason } = verdictFor(implied, cost12w);
  return {
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token',
    on_watchlist: false,
    age_days: age,
    implied_value_usd: implied,
    comps_value_usd: comps,
    peer_rate: peer,
    growth_tilt: gTilt,
    maturity_tilt: mTilt,
    verdict,
    verdict_reason: reason,
    farm_capital_usd: capital,
    farm_cost_12w_usd: cost12w,
    hold_days: hold,
    farm_steps: farmSteps(p, age).map(stepText),
  };
}

/** The ranked board: every watchlist slug, plus every other rankable pre-token protocol. */
export function buildBoard(snapshot: Snapshot, bands: PeerBand[]): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => scoreProtocol(p, snapshot.as_of, bands));
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const watch = new Set(snapshot.watchlist);
  return scored.map((s, i) => ({ ...s, on_watchlist: watch.has(s.slug), rank: i + 1 }));
}

/** The live-token protocols, by market cap: the market's own values, never a model's. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      mcap_per_tvl: Math.round((p.mcap_usd! / p.tvl_usd) * 1000) / 1000,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; fit: FitStats; bands: PeerBand[] } {
  const fit = fitComps(snapshot);
  if (Math.abs(fit.intercept - FIT_INTERCEPT) > FIT_TOLERANCE || Math.abs(fit.slope - FIT_SLOPE) > FIT_TOLERANCE) {
    throw new SnapshotError(
      `re-fit disagrees with the stated curve: fit ${fit.intercept} + ${fit.slope}*log10(TVL), stated ${FIT_INTERCEPT} + ${FIT_SLOPE}*log10(TVL)`,
    );
  }
  const bands = peerBands(snapshot);
  const board = buildBoard(snapshot, bands);
  const live = liveRows(snapshot);
  const counts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of board) counts[r.verdict]++;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    fit,
    peer_bands: bands,
    protocols_total: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    traded_fitted: fit.n,
    verdict_counts: counts,
    rows: board,
    live,
  };
  return { board, radar, fit, bands };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
