/**
 * Map, controls, and detail rendering.
 *
 * All arithmetic lives in engine.js; this file is presentation and wiring.
 * Every input recomputes all zones synchronously — 125 zones is small enough
 * that sliders stay instant without debouncing or a server round trip.
 */
(function () {
  'use strict';

  const MARKET = window.MARKET;
  const ZONES = window.ZONES;
  const $ = (id) => document.getElementById(id);

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
  let map, layer, tiles;
  let breaks = [];

  const TILES = {
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  };
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
    };
  }

  /** The value the choropleth encodes, per the active mode. */
  function metric(zoneProps, input) {
    if (state.mode === 'afford') {
      return Engine.affordablePrice(zoneProps, input, MARKET, +$('budget').value || 0);
    }
    const m = Engine.monthly(zoneProps, input, MARKET);
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
    return usd(v);
  }

  function updateLegend(lo, hi) {
    $('legendScale').innerHTML = ramp()
      .map((c) => `<i style="background:${c}"></i>`).join('');
    $('legendTitle').textContent = {
      monthly: 'Total monthly payment',
      rate: 'Effective tax rate',
      afford: 'Affordable home price',
    }[state.mode];
    $('legLo').textContent = fmtMetric(lo);
    $('legHi').textContent = fmtMetric(hi);
  }

  function syncHints(input) {
    const r = Engine.noteRate(MARKET, input);
    $('rateHint').textContent =
      `Using ${r.toFixed(2)}% — Freddie Mac PMMS ${MARKET.mortgage.rate_30yr}% ` +
      `(${MARKET.mortgage.as_of})${input.rateOverride ? ', overridden' : ' plus product spread'}.`;
    const ins = MARKET.insurance;
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
    const m = Engine.monthly(z, input, MARKET);
    const proj = Engine.project(z, input, MARKET, 10);

    let html = '';

    // Pinned comparison tray
    html += '<div class="pinbar">';
    for (const p of state.pinned) {
      const pz = ZONES.features.find((f) => f.properties.zone_id === p)?.properties;
      if (!pz) continue;
      const pm = Engine.monthly(pz, input, MARKET);
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

  /* --- Map setup ---------------------------------------------------------- */

  function initMap() {
    map = L.map('map', { zoomControl: true }).setView([29.47, -98.52], 10);
    tiles = L.tileLayer(TILES[isDark() ? 'dark' : 'light'], {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      maxZoom: 19,
    }).addTo(map);

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

    map.fitBounds(layer.getBounds(), { padding: [10, 10] });
  }

  /* --- Wiring ------------------------------------------------------------- */

  function initControls() {
    // Special district presets, richest county first.
    const sel = $('mudSel');
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
    sel.addEventListener('change', () => { $('mudRate').value = sel.value; refresh(); });

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

    const labels = { down: 'downLbl', localPct: 'localLbl', dwellPct: 'dwellLbl' };
    for (const el of document.querySelectorAll('aside input, aside select')) {
      el.addEventListener('input', () => {
        if (labels[el.id]) $(labels[el.id]).textContent = el.value + '%';
        refresh();
      });
    }

    $('themeBtn').addEventListener('click', () => {
      document.documentElement.setAttribute('data-theme', isDark() ? 'light' : 'dark');
      tiles.setUrl(TILES[isDark() ? 'dark' : 'light']);
      refresh(); // zone strokes are resolved token values, so restyle them too
    });

    $('vintage').textContent =
      `${MARKET.tax_year} certified tax rates · ${ZONES.features.length} tax zones · ` +
      `mortgage ${MARKET.mortgage.rate_30yr}% (${MARKET.mortgage.as_of}) · built ${MARKET.generated}`;

    $('srcs').innerHTML = 'Sources: ' + MARKET.provenance
      .map((p) => `<a href="${p.url}" target="_blank" rel="noopener">${esc(p.source)}</a>`)
      .filter((v, i, a) => a.indexOf(v) === i).join(' · ') +
      '. Estimates only — confirm with the appraisal district and a lender before relying on them.';
  }

  initMap();
  initControls();
  refresh();
})();
