// Comps-Fit Launch Radar: renders window.RADAR into the board, the detail view
// and the live table. No network: every figure comes from data.js beside the page.
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) { document.body.insertAdjacentHTML('beforeend', '<p>No radar data loaded.</p>'); return; }

  // The model, recomputed here in the page from each row's own figures, so the
  // number on screen is never taken on trust: comps is the curve fitted on
  // the 128 traded tokens in this snapshot (OLS, log-log; R2 0.194), the peer
  // rate is the listing-rate of the row's TVL band, and the two tilts are the
  // bounded tilts the model card states. impliedOf must return exactly the
  // implied value board.json carries for the same row.
  var FIT_A = 3.0247;
  var FIT_B = 0.5223;
  function round4(n) { return Math.round(n * 1e4) / 1e4; }
  function compsValue(tvl) { return Math.max(1, Math.round(Math.pow(10, FIT_A + FIT_B * Math.log10(tvl)))); }
  function peerRateFor(tvl) {
    var bands = R.peer_bands || [];
    for (var i = 0; i < bands.length; i++) {
      var b = bands[i];
      if (tvl >= b.low_usd && (b.high_usd === null || tvl < b.high_usd)) return b.rate;
    }
    return bands.length ? bands[bands.length - 1].rate : 0;
  }
  function growthTilt(chg) {
    var g = chg == null || !isFinite(chg) ? 0 : Math.min(120, Math.max(-60, chg));
    return round4(1 + (g / 100) * 0.25);
  }
  function maturityTilt(ageDays) {
    var d = ageDays == null ? 365 : ageDays;
    return round4(0.9 + (Math.min(Math.max(d, 0), 1095) / 1095) * 0.2);
  }
  function impliedOf(row) {
    return Math.max(1, Math.round(
      compsValue(row.tvl_usd) * peerRateFor(row.tvl_usd) * growthTilt(row.change_7d) * maturityTilt(row.age_days)));
  }

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n) { return n == null ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function age(n) { return n == null ? '—' : n >= 365 ? (n / 365).toFixed(1) + 'y' : n + 'd'; }

  // KPI strip and verdict counts.
  $('k-protocols').textContent = String(R.protocols_total);
  $('k-watchlist').textContent = String(R.watchlist_size);
  $('k-board').textContent = String(R.board_size);
  $('k-fitted').textContent = String(R.traded_fitted);
  $('v-farm').textContent = String(R.verdict_counts.FARM);
  $('v-thin').textContent = String(R.verdict_counts.THIN);
  $('v-skip').textContent = String(R.verdict_counts.SKIP);

  // Filter controls: categories and chains from the data.
  var cats = {}, chains = {};
  R.rows.forEach(function (r) {
    if (r.category) cats[r.category] = true;
    (r.chains || []).forEach(function (c) { chains[c] = true; });
  });
  Object.keys(cats).sort().forEach(function (c) {
    var o = document.createElement('option'); o.textContent = c; $('f-cat').appendChild(o);
  });
  Object.keys(chains).sort().forEach(function (c) {
    var o = document.createElement('option'); o.textContent = c; $('f-chain').appendChild(o);
  });

  var state = { q: '', cat: '', chain: '', verdict: '', watch: false, sort: 'rank', dir: 1 };
  var selected = null;

  function filtered() {
    var q = state.q.toLowerCase();
    var out = R.rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (state.watch && !r.on_watchlist) return false;
      return true;
    });
    var key = state.sort;
    out.sort(function (a, b) {
      var d = 0;
      if (key === 'rank') d = a.rank - b.rank;
      else if (key === 'name') d = a.name < b.name ? -1 : 1;
      else if (key === 'tvl') d = a.tvl_usd - b.tvl_usd;
      else if (key === 'growth') d = (a.change_7d || 0) - (b.change_7d || 0);
      else if (key === 'age') d = (a.age_days == null ? -1 : a.age_days) - (b.age_days == null ? -1 : b.age_days);
      else if (key === 'peer') d = a.peer_rate - b.peer_rate;
      else if (key === 'implied') d = a.implied_value_usd - b.implied_value_usd;
      else if (key === 'verdict') d = a.verdict < b.verdict ? -1 : 1;
      return d * state.dir;
    });
    return out;
  }

  function render() {
    var rows = filtered();
    var html = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"' + (selected === r.slug ? ' class="sel"' : '') + '>' +
        '<td class="rank">' + r.rank + (r.on_watchlist ? ' ★' : '') + '</td>' +
        '<td><b>' + esc(r.name) + '</b><span class="sub">' + esc(r.slug) + ' · ' + esc(r.category || '—') + '</span></td>' +
        '<td>' + money(r.tvl_usd) + '</td>' +
        '<td>' + pct(r.change_7d) + '</td>' +
        '<td>' + age(r.age_days) + '</td>' +
        '<td>' + r.peer_rate.toFixed(2) + '</td>' +
        '<td class="imp">' + money(r.implied_value_usd) + '</td>' +
        '<td><span class="badge ' + r.verdict + '">' + r.verdict + '</span></td>' +
        '<td>$' + r.farm_capital_usd + ' + $' + r.farm_cost_12w_usd + ' gas</td></tr>';
    }).join('');
    $('rows').innerHTML = html || '<tr><td colspan="9">No protocol matches this filter.</td></tr>';
    $('count').textContent = rows.length + ' of ' + R.rows.length + ' rows';
  }

  function detail(slug) {
    var r = null;
    R.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    selected = slug;
    var steps = (r.farm_steps || []).map(function (s, i) {
      return '<li><b>Step ' + (i + 1) + '.</b> ' + esc(s) + '</li>';
    }).join('');
    var recomputed = impliedOf(r);
    var check = recomputed === r.implied_value_usd
      ? 'The page recomputes this row as ' + money(recomputed) + ' — the same number board.json carries.'
      : 'The page recomputes this row as ' + money(recomputed) + ' (board.json carries ' + money(r.implied_value_usd) + ').';
    $('detail').innerHTML =
      '<h2>' + esc(r.name) + ' <span class="slug">' + esc(r.slug) + ' · rank ' + r.rank +
      (r.on_watchlist ? ' · on the watchlist ★' : '') + '</span></h2>' +
      '<p class="meta">' + esc(r.category || 'Uncategorised') + ' · ' + esc((r.chains || []).join(', ') || '—') +
      ' · TVL ' + money(r.tvl_usd) + ' · 7-day ' + pct(r.change_7d) + ' · age ' + age(r.age_days) +
      ' · records no token</p>' +
      '<div class="math">' +
      '<div><span>comps value</span><b>' + money(compsValue(r.tvl_usd)) + '</b></div>' +
      '<div><span>peer listing-rate</span><b>' + peerRateFor(r.tvl_usd).toFixed(2) + '</b></div>' +
      '<div><span>growth tilt &times; maturity tilt</span><b>' + growthTilt(r.change_7d).toFixed(2) + ' &times; ' + maturityTilt(r.age_days).toFixed(2) + '</b></div>' +
      '<div><span>implied value</span><b>' + money(recomputed) + '</b></div></div>' +
      '<p class="note">' + check + '</p>' +
      '<p><span class="badge ' + r.verdict + '">' + r.verdict + '</span> ' + esc(r.verdict_reason) +
      ' Capital $' + r.farm_capital_usd + ', gas $' + r.farm_cost_12w_usd + ' over 12 weeks, hold ' + r.hold_days + ' days.</p>' +
      '<ol class="steps">' + steps + '</ol>';
    render();
  }

  // Live table: tokens that already trade, at market value.
  $('live-rows').innerHTML = R.live.map(function (p) {
    return '<tr><td><b>' + esc(p.name) + '</b><span class="sub">' + esc(p.slug) + ' · ' + esc(p.category || '—') + '</span></td>' +
      '<td>' + money(p.tvl_usd) + '</td><td>' + money(p.mcap_usd) + '</td>' +
      '<td>' + p.mcap_per_tvl.toFixed(2) + '</td><td>' + pct(p.change_7d) + '</td></tr>';
  }).join('');

  // Events.
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) { detail(tr.getAttribute('data-slug')); $('detail').scrollIntoView({ block: 'nearest' }); }
  });
  $('q').addEventListener('input', function () { state.q = $('q').value; render(); });
  $('f-cat').addEventListener('change', function () { state.cat = $('f-cat').value; render(); });
  $('f-chain').addEventListener('change', function () { state.chain = $('f-chain').value; render(); });
  $('f-verdict').addEventListener('change', function () { state.verdict = $('f-verdict').value; render(); });
  $('f-watch').addEventListener('change', function () { state.watch = $('f-watch').checked; render(); });
  $('f-sort').addEventListener('change', function () { state.sort = $('f-sort').value; state.dir = 1; render(); });
  document.querySelectorAll('#board thead th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-sort');
      if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = 1; }
      render();
    });
  });

  // Deep links for the three screenshots: #detail=<slug>, #verdict=FARM|THIN|SKIP,
  // #watchlist=1, #sort=<key>. The watchlist flag comes from data.js rows.
  function applyHash() {
    var h = (location.hash || '').replace(/^#/, '');
    if (!h) return;
    h.split('&').forEach(function (part) {
      var kv = part.split('=');
      var k = decodeURIComponent(kv[0] || ''), v = decodeURIComponent(kv[1] || '');
      if (k === 'verdict' && (v === 'FARM' || v === 'THIN' || v === 'SKIP')) {
        state.verdict = v; $('f-verdict').value = v;
      } else if (k === 'watchlist' && v === '1') {
        state.watch = true; $('f-watch').checked = true;
      } else if (k === 'sort') {
        state.sort = v; var s = $('f-sort'); if (s.querySelector('option[value="' + v + '"]')) s.value = v;
      } else if (k === 'detail' && v) {
        detail(v);
        var el = $('detail');
        if (el && el.scrollIntoView) el.scrollIntoView();
        window.scrollTo(0, el ? el.offsetTop - 12 : 0);
      }
    });
  }

  render();
  applyHash();
  render();
})();
