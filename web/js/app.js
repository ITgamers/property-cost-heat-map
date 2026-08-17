/**
 * Map, controls, and detail rendering.
 *
 * All arithmetic lives in engine.js; this file is presentation and wiring.
 * Every input recomputes all zones synchronously — 125 zones is small enough
 * that sliders stay instant without debouncing or a server round trip.
 */
(function () {
  'use strict';

  // Reassignable: a successful update swaps both wholesale (see applyData).
  let MARKET = window.MARKET;
  let ZONES = window.ZONES;
  const $ = (id) => document.getElementById(id);
  const CACHE_KEY = 'pchm.data.v1';
  const ADV_KEY = 'pchm.assumptions.v1';

  /* --- User-overridable assumptions ---------------------------------------
   * The figures in data/assumptions.json are the ones no public feed
   * publishes. Editing that file is a code change; these controls let the same
   * values be adjusted from the page for a scenario, or corrected when one
   * moves before the repo catches up. Stored in this browser only.
   *
   * `eff` is the published data with any overrides layered on. It is rebuilt
   * only when an override changes, never per zone - metric() runs across every
   * zone on each keystroke, so cloning there would be wasteful.
   * ---------------------------------------------------------------------- */

  const ADV_FIELDS = [
    'school_homestead', 'senior_extra', 'senior_flat', 'cap_pct',
    'ins_avg', 'ins_dwelling', 'spread_15yr', 'spread_fha', 'spread_va',
  ];
  let overrides = {};
  let eff = null;                     // effective market; null => use MARKET
  const mkt = () => eff || MARKET;

  /** Read the published value a given override defaults to. */
  function publishedValue(key, m) {
    const ex = m.exemptions.TX, ins = m.insurance, mo = m.mortgage;
    switch (key) {
      case 'school_homestead': return ex.school_homestead;
      case 'senior_extra': return ex.school_homestead_senior_extra;
      case 'senior_flat': return ex.senior_flat;
      case 'cap_pct': return ex.appraisal_cap_pct * 100;
      case 'ins_avg': return ins.state_avg_annual;
      case 'ins_dwelling': return ins.state_avg_dwelling;
      case 'spread_15yr': return mo.spread_15yr;
      case 'spread_fha': return mo.spread_fha;
      case 'spread_va': return mo.spread_va;
    }
  }

  /** Rebuild `eff` from MARKET + overrides. */
  function applyOverrides() {
    const keys = Object.keys(overrides);
    $('advBadge').hidden = keys.length === 0;
    if (!keys.length) { eff = null; return; }

    const m = JSON.parse(JSON.stringify(MARKET));
    const ex = m.exemptions.TX;
    const o = overrides;
    if (o.school_homestead != null) ex.school_homestead = o.school_homestead;
    if (o.senior_extra != null) ex.school_homestead_senior_extra = o.senior_extra;
    if (o.senior_flat != null) ex.senior_flat = o.senior_flat;
    if (o.cap_pct != null) ex.appraisal_cap_pct = o.cap_pct / 100;
    if (o.ins_avg != null) m.insurance.state_avg_annual = o.ins_avg;
    if (o.ins_dwelling != null) m.insurance.state_avg_dwelling = Math.max(1, o.ins_dwelling);
    for (const s of ['spread_15yr', 'spread_fha', 'spread_va']) {
      if (o[s] != null) m.mortgage[s] = o[s];
    }
    eff = m;
  }

  /** Fill the inputs from published values, keeping any active overrides. */
  function syncAdvInputs() {
    for (const key of ADV_FIELDS) {
      const el = document.querySelector(`[data-adv="${key}"]`);
      if (el) el.value = overrides[key] != null ? overrides[key] : publishedValue(key, MARKET);
    }
    $('advBadge').hidden = Object.keys(overrides).length === 0;
  }

  function loadOverrides() {
    try {
      const raw = localStorage.getItem(ADV_KEY);
      if (raw) overrides = JSON.parse(raw) || {};
    } catch (e) { overrides = {}; }
  }
  function saveOverrides() {
    try {
      Object.keys(overrides).length
        ? localStorage.setItem(ADV_KEY, JSON.stringify(overrides))
        : localStorage.removeItem(ADV_KEY);
    } catch (e) { /* storage disabled; overrides still apply this session */ }
  }

  // Sequential blue, steps 100 -> 700. Index 0 is always the lowest bin.
  const RAMP_STEPS = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];

  /**
   * Dark mode is a selected ramp direction, not an inversion of the light one.
   * The invariant being preserved is "the low end recedes toward the surface":
   * on the light basemap that means starting pale, on the dark basemap it means
   * starting deep. Flipping keeps high values the most salient in both themes,
   * which is what a magnitude encoding is supposed to do.
   */
  const ramp = () => (isDark() ? [...RAMP_STEPS].reverse() : RAMP_STEPS);
  const STACK_COLORS = {
    school: 'var(--c1)', city: 'var(--c2)', county: 'var(--c3)',
    countywide: 'var(--c4)', special: 'var(--c5)',
  };

  const usd = (v, dp = 0) => '$' + v.toLocaleString('en-US', {
    minimumFractionDigits: dp, maximumFractionDigits: dp,
  });
  const pct = (v, dp = 3) => v.toFixed(dp) + '%';

  let state = {
    mode: 'monthly', selected: null, pinned: [],
    heatOn: true, heatOpacity: 0.78,
  };
  let map, layer, tiles, fitted = false;
  let breaks = [];

  const TILES = {
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  };
  // CARTO's free tier carries no SLA and throttles under load. Falling back to
  // OSM standard tiles means a rate-limited basemap degrades to a different
  // basemap rather than to a blank background. OSM has no dark variant, so the
  // tile pane gets filtered instead when the fallback runs in dark mode.
  const FALLBACK_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  let tileErrors = 0, usingFallback = false;
  const tileUrl = () => (usingFallback ? FALLBACK_TILES : TILES[isDark() ? 'dark' : 'light']);

  function syncTilePane() {
    const pane = document.querySelector('.leaflet-tile-pane');
    if (pane) pane.classList.toggle('fallback-dark', usingFallback && isDark());
  }
  const isDark = () => {
    const t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  };

  /* --- Input collection --------------------------------------------------- */

  function readInputs() {
    const price = +$('price').value || 0;
    return {
      state: 'TX',
      price,
      assessedValue: +$('assessed').value || 0,
      assessedRatio: price > 0 ? (+$('assessed').value || 0) / price : 1,
      downPct: (+$('down').value || 0) / 100,
      term: +document.querySelector('#termSeg [aria-pressed="true"]').dataset.v,
      loanType: document.querySelector('#typeSeg [aria-pressed="true"]').dataset.v,
      rateOverride: $('rate').value,
      pmiPct: +$('pmi').value || 0,
      homestead: $('homestead').checked,
      senior: $('senior').checked,
      localOptionalPct: (+$('localPct').value || 0) / 100,
      hoaMonthly: +$('hoa').value || 0,
      specialRate: +$('mudRate').value || 0,
      specialName: $('mudSel').selectedOptions[0]?.dataset.name,
      insuranceOverride: $('insOverride').value,
      dwellingPct: (+$('dwellPct').value || 85) / 100,
      appreciationPct: +$('appr').value || 0,
      insuranceInflationPct: +$('insInf').value || 0,
      closing: readClosing(),
    };
  }

  /** Itemized closing inputs, read straight off their data-fee attributes. */
  function readClosing() {
    const c = {
      closingMonth: +$('closeMonth').value || 6,
      sellerCredit: +$('sellerCredit').value || 0,
    };
    for (const el of document.querySelectorAll('[data-fee]')) {
      c[el.dataset.fee] = +el.value || 0;
    }
    return c;
  }

  /** The value the choropleth encodes, per the active mode. */
  function metric(zoneProps, input) {
    if (state.mode === 'afford') {
      return Engine.affordablePrice(zoneProps, input, mkt(), +$('budget').value || 0);
    }
    if (state.mode === 'cash') {
      return Engine.cashToClose(zoneProps, input, mkt()).total;
    }
    const m = Engine.monthly(zoneProps, input, mkt());
    return state.mode === 'rate' ? m.effectiveTaxRate : m.total;
  }

  /* --- Choropleth --------------------------------------------------------- */

  /**
   * Quantile breaks rather than equal interval. Tax rates cluster tightly with
   * a couple of outliers; equal-interval would dump 90% of zones into one bin
   * and show a flat map.
   */
  function computeBreaks(values) {
    const s = [...values].sort((a, b) => a - b);
    const out = [];
    for (let i = 1; i < RAMP_STEPS.length; i++) {
      out.push(s[Math.floor((i / RAMP_STEPS.length) * s.length)]);
    }
    return out;
  }

  function colorFor(v) {
    const r = ramp();
    for (let i = 0; i < breaks.length; i++) if (v < breaks[i]) return r[i];
    return r[r.length - 1];
  }

  function refresh() {
    const input = readInputs();
    const values = ZONES.features.map((f) => {
      f.properties._v = metric(f.properties, input);
      return f.properties._v;
    });
    breaks = computeBreaks(values);

    layer.setStyle((f) => baseStyle(f));
    if (state.selected) layer.eachLayer((l) => {
      if (l.feature.properties.zone_id === state.selected) l.setStyle(selStyle());
    });

    updateLegend(Math.min(...values), Math.max(...values));
    renderDetail();
    syncLabels(input);
    syncHints(input);
  }

  /**
   * Leaflet writes stroke/fill as SVG presentation attributes, where CSS custom
   * properties do not resolve. Read the token's computed value instead of
   * handing var(...) to the renderer.
   */
  const cssVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#ffffff';

  /**
   * With shading off the fill goes fully transparent so the basemap roads read
   * through, and the zone's colour moves onto its outline — you keep the
   * boundaries and keep the signal. Clickability with a transparent fill comes
   * from the pointer-events rule in app.css, not from SVG defaults.
   */
  const baseStyle = (f) => {
    const c = colorFor(f.properties._v);
    return state.heatOn
      ? { fillColor: c, fillOpacity: state.heatOpacity, color: cssVar('--surface-1'), weight: 0.7, opacity: 0.9 }
      : { fillColor: c, fillOpacity: 0, color: c, weight: 1.6, opacity: 0.95 };
  };
  const selStyle = () => ({
    weight: 3,
    color: cssVar('--critical'),
    opacity: 1,
    fillOpacity: state.heatOn ? 0.85 : 0,
  });
  const hoverStyle = () => ({ weight: 2.5, color: cssVar('--text-primary') });

  function fmtMetric(v) {
    if (state.mode === 'rate') return pct(v, 3);
    if (state.mode === 'afford') return usd(Math.round(v / 1000) * 1000);
    if (state.mode === 'cash') return usd(Math.round(v / 100) * 100);
    return usd(v);
  }

  function updateLegend(lo, hi) {
    $('legendScale').innerHTML = ramp()
      .map((c) => `<i style="background:${c}"></i>`).join('');
    $('legendTitle').textContent = {
      monthly: 'Total monthly payment',
      rate: 'Effective tax rate',
      afford: 'Affordable home price',
      cash: 'Cash needed at closing',
    }[state.mode];
    $('legLo').textContent = fmtMetric(lo);
    $('legHi').textContent = fmtMetric(hi);
  }

  /**
   * Show the dollar figure beside each percentage control, so the sliders read
   * as money rather than as arithmetic homework. Driven from refresh() rather
   * than the slider's own handler, so changing the price updates them too.
   */
  function syncLabels(input) {
    const down = input.price * input.downPct;
    $('downLbl').textContent = `${$('down').value}% — ${usd(down)} down`;
    $('loanLbl').textContent = usd(Math.max(0, input.price - down));
    $('localLbl').textContent = `${$('localPct').value}%`;
    $('dwellLbl').textContent =
      `${$('dwellPct').value}% — ${usd(input.price * input.dwellingPct)}`;
  }

  function syncHints(input) {
    const r = Engine.noteRate(mkt(), input);
    $('rateHint').textContent =
      `Using ${r.toFixed(2)}% — Freddie Mac PMMS ${MARKET.mortgage.rate_30yr}% ` +
      `(${MARKET.mortgage.as_of})${input.rateOverride ? ', overridden' : ' plus product spread'}.`;
    const ins = mkt().insurance;   // reflects any assumption override
    $('insHint').textContent = input.insuranceOverride
      ? 'Using your figure.'
      : `Estimated from the Texas average (${usd(ins.state_avg_annual)} at ` +
        `${usd(ins.state_avg_dwelling)} dwelling). An estimate, not a quote.`;
  }

  /* --- Detail panel ------------------------------------------------------- */

  function renderDetail() {
    const el = $('detail');
    const input = readInputs();
    const zones = [state.selected, ...state.pinned]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .map((id) => ZONES.features.find((f) => f.properties.zone_id === id)?.properties)
      .filter(Boolean);

    if (!zones.length) {
      el.innerHTML = '<div class="empty">Click any area on the map to see a full cost breakdown.</div>';
      return;
    }

    const z = zones[0];
    const m = Engine.monthly(z, input, mkt());
    const proj = Engine.project(z, input, mkt(), 10);
    const cash = Engine.cashToClose(z, input, mkt());

    let html = '';

    // Pinned comparison tray
    html += '<div class="pinbar">';
    for (const p of state.pinned) {
      const pz = ZONES.features.find((f) => f.properties.zone_id === p)?.properties;
      if (!pz) continue;
      const pm = Engine.monthly(pz, input, mkt());
      html += `<span class="pill">${esc(short(pz))} — <b>${usd(pm.total)}/mo</b>
        <button type="button" data-unpin="${pz.zone_id}" aria-label="Remove">×</button></span>`;
    }
    if (state.selected && !state.pinned.includes(state.selected)) {
      html += `<button class="ghost" type="button" id="pinBtn">+ Pin to compare</button>`;
    }
    html += '</div>';

    html += `<h2>${esc(z.isd)}</h2>
      <div class="sub">${esc(z.city || 'Unincorporated')} · ${esc(z.county)} County
      · combined rate ${pct(z.total_rate, 4)} per $100</div>`;

    // Headline tiles
    html += '<div class="tiles">' +
      tile('Total monthly', usd(m.total), 'PITI + HOA + special districts') +
      tile('Property tax', usd(m.taxAnnual, 0) + '/yr', usd(m.taxAnnual / 12) + '/mo · effective ' + pct(m.effectiveTaxRate, 3)) +
      tile('Insurance', usd(m.insuranceAnnual, 0) + '/yr', usd(m.insuranceAnnual / 12) + '/mo · estimate') +
      tile('Principal & interest', usd(m.loan.monthlyPI), `${m.loan.rate.toFixed(2)}% · ${input.term}-yr · ${usd(m.loan.principal)} loan`) +
      tile('Cash to close', usd(cash.total, 0),
           `${cash.pctOfPrice.toFixed(1)}% of price · ${usd(cash.total - cash.downPayment)} beyond the down payment`) +
      tile('10-year total', usd(proj[9].cumulative, 0), 'year 10 runs ' + usd(proj[9].monthly) + '/mo') +
      '</div>';

    // Warnings
    if (input.specialRate > 0) {
      const extra = (input.assessedValue * input.specialRate) / 100;
      html += `<div class="note crit"><strong>Special district adds ${usd(extra)}/yr</strong>
        (${usd(extra / 12)}/mo) at ${input.specialRate} per $100, with no exemption
        applied. This sits on top of every rate shown on the map.</div>`;
    } else if (z.county === 'Bexar') {
      html += `<div class="note"><strong>Check for a MUD or PID before you offer.</strong>
        Several Bexar developments carry one — Redbird Ranch WCID levies
        1.00 per $100, about ${usd(input.assessedValue / 100)} a year extra on this
        home. They are parcel-level and cannot be mapped; set one in the sidebar
        to see the impact.</div>`;
    }
    if (!input.homestead) {
      html += `<div class="note"><strong>No homestead exemption applied.</strong>
        Filing would remove $140,000 from school-district taxable value.</div>`;
    }

    html += '<div class="cols">';

    // Monthly composition — stacked bar with direct labels + table (the light-mode
    // contrast relief required by the palette check).
    const parts = [
      ['principalInterest', 'Principal & interest', 'school'],
      ['tax', 'Property tax', 'county'],
      ['insurance', 'Insurance', 'city'],
      ['mortgageInsurance', 'Mortgage insurance', 'countywide'],
      ['hoa', 'HOA', 'special'],
    ].filter(([k]) => m.parts[k] > 0.5);

    html += '<div><h3>Monthly payment</h3><div class="stack">';
    for (const [k, , c] of parts) {
      html += `<i style="background:${STACK_COLORS[c]};flex:${m.parts[k]}"></i>`;
    }
    html += '</div><table class="data"><tbody>';
    for (const [k, label, c] of parts) {
      html += `<tr><td><span class="swatch" style="background:${STACK_COLORS[c]}"></span>${label}</td>
        <td class="num">${usd(m.parts[k])}</td>
        <td class="num">${((m.parts[k] / m.total) * 100).toFixed(0)}%</td></tr>`;
    }
    html += `</tbody><tfoot><tr><td>Total</td><td class="num">${usd(m.total)}</td><td></td></tr></tfoot></table>`;
    if (m.loan.miNote) html += `<div class="hint" style="margin-top:6px;color:var(--muted)">${esc(m.loan.miNote)}</div>`;
    html += '</div>';

    // Per-jurisdiction tax stack
    html += '<div><h3>Who taxes this home</h3><table class="data"><thead><tr>' +
      '<th>Taxing unit</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">Annual</th>' +
      '</tr></thead><tbody>';
    for (const l of m.taxLines) {
      html += `<tr><td><span class="swatch" style="background:${STACK_COLORS[l.kind] || 'var(--muted)'}"></span>${esc(l.name)}</td>
        <td class="num">${l.rate.toFixed(4)}</td>
        <td class="num">${usd(l.taxable)}</td>
        <td class="num">${usd(l.amount)}</td></tr>`;
    }
    html += `</tbody><tfoot><tr><td>Total</td><td class="num">${z.total_rate.toFixed(4)}</td>
      <td></td><td class="num">${usd(m.taxAnnual)}</td></tr></tfoot></table>
      <div class="hint" style="margin-top:6px;color:var(--muted)">
      Taxable values differ by unit because exemptions do — the school exemption is
      a flat $140,000, the local option a percentage.</div></div>`;

    // Projection
    html += '<div><h3>10-year outlook</h3><table class="data"><thead><tr>' +
      '<th>Year</th><th class="num">Appraised</th><th class="num">Tax</th>' +
      '<th class="num">Insurance</th><th class="num">Monthly</th></tr></thead><tbody>';
    for (const r of proj.filter((r) => [1, 2, 3, 5, 10].includes(r.year))) {
      html += `<tr><td>${r.year}</td><td class="num">${usd(r.assessed)}</td>
        <td class="num">${usd(r.tax)}</td><td class="num">${usd(r.insurance)}</td>
        <td class="num">${usd(r.monthly)}</td></tr>`;
    }
    html += `</tbody></table><div class="hint" style="margin-top:6px;color:var(--muted)">
      Appraisal growth ${input.appreciationPct}%/yr${input.homestead ? ', capped at 10% by the homestead cap' : ' (uncapped without a homestead)'};
      insurance ${input.insuranceInflationPct}%/yr.</div></div>`;

    // Cash to close — one-time, deliberately separate from the monthly figure.
    const cashRow = (label, amt, cls) =>
      `<tr><td${cls ? ` class="${cls}"` : ''}>${esc(label)}</td>` +
      `<td class="num">${amt < 0 ? '−' : ''}${usd(Math.abs(amt))}</td></tr>`;

    html += '<div><h3>Cash to close</h3><table class="data"><tbody>';
    html += cashRow('Down payment', cash.downPayment);
    for (const f of cash.fees) if (f.amount > 0) html += cashRow(f.name, f.amount);
    for (const p of cash.prepaids) if (p.amount > 0) html += cashRow(p.name, p.amount);
    for (const c of cash.credits) if (c.amount > 0) html += cashRow(c.name, -c.amount, 'credit');
    html += `</tbody><tfoot><tr><td>Cash needed</td>
      <td class="num">${usd(cash.total)}</td></tr></tfoot></table>`;
    if (cash.financedFee > 0) {
      html += `<div class="hint" style="margin-top:6px;color:var(--muted)">
        Plus ${usd(cash.financedFee)} of upfront mortgage insurance or funding fee,
        financed into the loan rather than paid at the table.</div>`;
    }
    html += `<div class="hint" style="margin-top:6px;color:var(--muted)">
      Assumes a mid-month close. The tax escrow deposit and the seller's proration
      credit both grow with the closing month and cancel out, leaving roughly
      2.5 months of tax whichever month you close. Estimates — your lender's Loan
      Estimate governs.</div></div>`;

    html += '</div>';
    el.innerHTML = html;

    $('pinBtn')?.addEventListener('click', () => {
      if (state.pinned.length < 3) state.pinned.push(state.selected);
      renderDetail();
    });
    el.querySelectorAll('[data-unpin]').forEach((b) =>
      b.addEventListener('click', () => {
        state.pinned = state.pinned.filter((p) => p !== b.dataset.unpin);
        renderDetail();
      }));
  }

  const tile = (k, v, s) =>
    `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const short = (z) => `${z.isd.replace(/ Independent School District/, '')} / ${z.city || 'Uninc.'}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* --- Live data updates --------------------------------------------------
   * The browser cannot refresh from the original sources: neither FRED nor the
   * Texas Comptroller sends an Access-Control-Allow-Origin header, so a direct
   * fetch is blocked no matter what we do client-side. A scheduled GitHub
   * Action re-runs the ETL and commits the output instead, and this fetches
   * that - raw.githubusercontent.com serves `*`, readable from any origin
   * including a page opened off the filesystem.
   * ------------------------------------------------------------------------ */

  const setStatus = (msg) => { $('updateStatus').textContent = msg || ''; };

  /**
   * Age the data out loud. The scheduled rebuild can stop silently — GitHub
   * disables cron workflows after 60 days of repository inactivity — and stale
   * tax rates look exactly like fresh ones. Surfacing the age is what turns a
   * silent wrong answer into a visible one.
   */
  const STALE_DAYS = 45;

  function dataAgeDays() {
    const d = Date.parse(MARKET.generated + 'T00:00:00Z');
    return isNaN(d) ? 0 : Math.floor((Date.now() - d) / 86400000);
  }

  function setVintage() {
    const age = dataAgeDays();
    $('vintage').textContent =
      `${MARKET.tax_year} certified tax rates · ${ZONES.features.length} tax zones · ` +
      `mortgage ${MARKET.mortgage.rate_30yr}% (${MARKET.mortgage.as_of}) · data ${MARKET.generated}`;

    const warn = $('staleWarn');
    if (age > STALE_DAYS) {
      const months = Math.floor(age / 30);
      const url = actionsUrl();
      // Past this age the likely cause is a stopped schedule, and the button
      // cannot fix that - it only mirrors the repo. Point at the one control
      // that actually re-fetches from the sources.
      warn.textContent = `⚠ Data is ${months >= 2 ? months + ' months' : age + ' days'} old — ` +
        (url ? 'run a refresh' : 'press Update data');
      if (url) warn.href = url;
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
  }

  /** Deep link to the workflow page, where "Run workflow" lives. */
  const actionsUrl = () =>
    MARKET.update && MARKET.update.repo
      ? `https://github.com/${MARKET.update.repo}/actions/workflows/update-data.yml`
      : null;

  /** Swap in a new dataset and rebuild everything that depends on it. */
  function applyData(market, zones) {
    MARKET = market;
    ZONES = zones;
    state.selected = null;
    state.pinned = [];
    if (layer) layer.remove();
    buildLayer();
    populateDistricts();
    // Overrides survive a data update, but are re-layered onto the new
    // published values and the unedited fields refreshed to the new defaults.
    applyOverrides();
    syncAdvInputs();
    setVintage();
    refresh();
  }

  function cacheData(market, zones) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ market, zones }));
    } catch (e) {
      // Quota exceeded on a ~1.2 MB payload, or storage disabled entirely.
      // Not fatal: the update still applied for this session.
      console.warn('Could not cache updated data:', e.message);
    }
  }

  /** Restore a previously downloaded update, if it is newer than what shipped. */
  function loadCached() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const { market, zones } = JSON.parse(raw);
      if (market && zones && market.generated > MARKET.generated) {
        MARKET = market;
        ZONES = zones;
      }
    } catch (e) {
      localStorage.removeItem(CACHE_KEY);
    }
  }

  /**
   * @param {boolean} manual  true when the user pressed the button, which makes
   *                          the outcome verbose. The silent load-time check
   *                          only speaks up when there is actually something new.
   */
  async function checkForUpdates(manual) {
    const base = MARKET.update && MARKET.update.base_url;
    if (!base) return manual && setStatus('No update source configured.');

    const btn = $('updateBtn');
    if (manual) { btn.disabled = true; setStatus('Checking…'); }
    const bust = () => '?t=' + Date.now();

    try {
      // market.json is ~10 KB, so the check itself is cheap. Only pull the
      // 1.2 MB zone geometry once we know there is a newer build.
      const r = await fetch(`${base}/market.json${bust()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const market = await r.json();

      if (!(market.generated > MARKET.generated)) {
        // "Up to date" only means "matches the repo". If the repo itself is old,
        // say so plainly rather than implying the figures are current.
        const age = dataAgeDays();
        return manual && setStatus(
          age > STALE_DAYS
            ? `Repo has nothing newer — its data is ${MARKET.generated}. The scheduled refresh may have stopped.`
            : `Up to date (${MARKET.generated}).`
        );
      }

      if (manual) setStatus('Newer data found — downloading…');
      const z = await fetch(`${base}/zones.geojson${bust()}`, { cache: 'no-store' });
      if (!z.ok) throw new Error('HTTP ' + z.status);
      const zones = await z.json();
      if (!zones.features || !zones.features.length) throw new Error('empty dataset');

      applyData(market, zones);
      cacheData(market, zones);
      setStatus(`Updated to ${market.generated}.`);
    } catch (e) {
      // Offline, rate-limited, or the repo moved. The bundled data still works.
      if (manual) setStatus(`Update failed (${e.message}) — using data from ${MARKET.generated}.`);
      else console.warn('Update check failed:', e.message);
    } finally {
      if (manual) btn.disabled = false;
    }
  }

  /* --- Map setup ---------------------------------------------------------- */

  function initMap() {
    map = L.map('map', { zoomControl: true }).setView([29.47, -98.52], 10);
    tiles = L.tileLayer(tileUrl(), {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      maxZoom: 19,
    }).addTo(map);

    // A few misses are normal while panning; a sustained run means the tile
    // host is refusing us, so switch source once and stay there.
    tiles.on('tileerror', () => {
      if (usingFallback || ++tileErrors < 6) return;
      usingFallback = true;
      tiles.setUrl(FALLBACK_TILES);
      syncTilePane();
    });

    buildLayer();
  }

  /** (Re)create the choropleth layer from the current ZONES. */
  function buildLayer() {
    layer = L.geoJSON(ZONES, {
      style: baseStyle,
      onEachFeature: (f, l) => {
        l.on('click', () => {
          state.selected = f.properties.zone_id;
          refresh();
          $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        l.on('mouseover', () => l.setStyle(hoverStyle()));
        l.on('mouseout', () => {
          if (f.properties.zone_id !== state.selected) layer.resetStyle(l);
          else l.setStyle(selStyle());
        });
        l.bindTooltip(() =>
          `<b>${esc(short(f.properties))}</b><br>${fmtMetric(f.properties._v)}` +
          `<br><span style="color:#666">${pct(f.properties.total_rate, 4)} per $100</span>`,
          { sticky: true });
      },
    }).addTo(map);

    // Frame the data on first build only. An update mid-session should leave
    // wherever the user has panned to alone.
    if (!fitted) {
      map.fitBounds(layer.getBounds(), { padding: [10, 10] });
      fitted = true;
    }
  }

  /* --- Wiring ------------------------------------------------------------- */

  /** Fill the special-district dropdown from the current MARKET. */
  function populateDistricts() {
    const sel = $('mudSel');
    sel.innerHTML = '<option value="0">None</option>';
    for (const [county, list] of Object.entries(MARKET.optional_districts || {})) {
      const og = document.createElement('optgroup');
      og.label = county + ' County';
      for (const d of list) {
        const o = document.createElement('option');
        o.value = d.rate;
        o.dataset.name = d.name;
        o.textContent = `${d.name} — ${d.rate} per $100`;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
  }

  function initControls() {
    populateDistricts();
    $('mudSel').addEventListener('change', (e) => {
      $('mudRate').value = e.target.value;
      refresh();
    });

    // Segmented controls
    for (const id of ['termSeg', 'typeSeg']) {
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        $(id).querySelectorAll('button').forEach((x) =>
          x.setAttribute('aria-pressed', String(x === b)));
        refresh();
      });
    }

    document.querySelector('.maptools').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !b.dataset.mode) return;   // the heat toggle handles itself
      state.mode = b.dataset.mode;
      document.querySelectorAll('.maptools button[data-mode]').forEach((x) =>
        x.setAttribute('aria-pressed', String(x === b)));
      refresh();
    });

    // Shading on/off and its opacity.
    const setHeat = (on) => {
      state.heatOn = on;
      $('heatBtn').setAttribute('aria-pressed', String(on));
      $('heatOpacity').disabled = !on;
      refresh();
    };
    $('heatBtn').addEventListener('click', () => setHeat(!state.heatOn));
    $('heatOpacity').addEventListener('input', (e) => {
      state.heatOpacity = +e.target.value / 100;
      if (!state.heatOn) setHeat(true);   // dragging it implies you want it back
      else refresh();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() !== 'h') return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      setHeat(!state.heatOn);
    });

    // Keep appraised value tracking price until the user edits it directly.
    let assessedTouched = false;
    $('assessed').addEventListener('input', () => { assessedTouched = true; });
    $('price').addEventListener('input', () => {
      if (!assessedTouched) $('assessed').value = $('price').value;
    });

    // Assumption fields are handled separately below - they must rebuild the
    // effective market before anything recomputes.
    // refresh() repaints the percentage labels via syncLabels, so handlers here
    // only need to trigger it.
    for (const el of document.querySelectorAll(
      'aside input:not([data-adv]), aside select'
    )) {
      el.addEventListener('input', refresh);
    }

    // Assumptions: an empty field or one matching the published default is not
    // an override, so it drops out rather than being pinned to a stale number.
    for (const el of document.querySelectorAll('[data-adv]')) {
      el.addEventListener('input', () => {
        const key = el.dataset.adv;
        const raw = el.value.trim();
        const val = Number(raw);
        if (raw === '' || Number.isNaN(val) || val === publishedValue(key, MARKET)) {
          delete overrides[key];
        } else {
          overrides[key] = val;
        }
        applyOverrides();
        saveOverrides();
        refresh();
      });
    }

    $('advReset').addEventListener('click', () => {
      overrides = {};
      applyOverrides();
      saveOverrides();
      syncAdvInputs();
      refresh();
    });

    $('themeBtn').addEventListener('click', () => {
      document.documentElement.setAttribute('data-theme', isDark() ? 'light' : 'dark');
      tiles.setUrl(tileUrl());
      syncTilePane();
      refresh(); // zone strokes are resolved token values, so restyle them too
    });

    $('updateBtn').addEventListener('click', () => checkForUpdates(true));
    setVintage();

    $('srcs').innerHTML = 'Sources: ' + MARKET.provenance
      .map((p) => `<a href="${p.url}" target="_blank" rel="noopener">${esc(p.source)}</a>`)
      .filter((v, i, a) => a.indexOf(v) === i).join(' · ') +
      '. Estimates only — confirm with the appraisal district and a lender before relying on them.';
  }

  loadCached();     // prefer a previously downloaded update over what shipped
  loadOverrides();
  applyOverrides();
  initMap();
  initControls();
  syncAdvInputs();
  refresh();
  // Quiet check on load: only surfaces if something newer actually exists.
  checkForUpdates(false);
})();
