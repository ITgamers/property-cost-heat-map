/**
 * Property cost rules engine.
 *
 * Deliberately jurisdiction-agnostic. Everything Texas-specific lives in the
 * data (market.json's `exemptions` block and each zone's rate stack), so adding
 * another state means adding a rule set, not editing this file.
 *
 * The important structural point: property tax is NOT one blended rate applied
 * to one taxable value. Each taxing unit applies its own rate to its own taxable
 * value, because exemptions differ per unit. Texas school districts grant a
 * $140,000 homestead exemption that cities and counties do not; cities and
 * counties grant a percentage exemption that schools generally do not. Blending
 * the rates first produces the wrong answer the moment a homestead is involved.
 */
(function (global) {
  'use strict';

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round2 = (v) => Math.round(v * 100) / 100;

  /* ---------------------------------------------------------------------
   * Property tax
   * ------------------------------------------------------------------ */

  /**
   * Compute the annual property tax bill for one zone, unit by unit.
   *
   * @param {object} zone   Zone properties (carries the rate stack).
   * @param {object} input  User inputs.
   * @param {object} rules  Exemption rule set (market.exemptions.TX).
   * @returns {{total:number, lines:Array}} Annual dollars plus a per-unit trace.
   */
  function propertyTax(zone, input, rules) {
    const assessed = Math.max(0, input.assessedValue);
    const hs = !!input.homestead;
    const senior = hs && !!input.senior;
    const lines = [];

    // School district: flat-dollar homestead exemption off the taxable value.
    let schoolExempt = 0;
    if (hs) {
      schoolExempt += rules.school_homestead;
      if (senior) schoolExempt += rules.school_homestead_senior_extra;
    }
    const schoolTaxable = Math.max(0, assessed - schoolExempt);
    lines.push({
      name: zone.isd,
      kind: 'school',
      rate: zone.rates.school,
      taxable: schoolTaxable,
      exempt: schoolExempt,
      amount: (schoolTaxable * zone.rates.school) / 100,
    });

    // City / county / county-wide units: percentage exemption instead.
    const pct = hs ? clamp(input.localOptionalPct ?? rules.local_optional_pct, 0, 0.2) : 0;
    const localTaxable = Math.max(0, assessed * (1 - pct) - (senior ? rules.senior_flat : 0));

    const localUnits = [
      { name: zone.county + ' County', kind: 'county', rate: zone.rates.county },
    ];
    if (zone.rates.city > 0) {
      localUnits.push({ name: 'City of ' + zone.city, kind: 'city', rate: zone.rates.city });
    }
    for (const u of zone.rates.countywide) {
      localUnits.push({ name: u.name, kind: 'countywide', rate: u.rate });
    }
    for (const u of localUnits) {
      lines.push({
        ...u,
        taxable: localTaxable,
        exempt: assessed - localTaxable,
        amount: (localTaxable * u.rate) / 100,
      });
    }

    // Opt-in special districts (MUD / WCID / PID / ESD). These are parcel-level
    // and cannot be derived from published boundaries, so the user names them.
    // No exemptions are assumed to apply.
    if (input.specialRate > 0) {
      lines.push({
        name: input.specialName || 'Special district (MUD/PID/ESD)',
        kind: 'special',
        rate: input.specialRate,
        taxable: assessed,
        exempt: 0,
        amount: (assessed * input.specialRate) / 100,
      });
    }

    return { total: lines.reduce((s, l) => s + l.amount, 0), lines };
  }

  /* ---------------------------------------------------------------------
   * Mortgage
   * ------------------------------------------------------------------ */

  /** Level-payment amortization. Handles the 0% edge case. */
  function amortize(principal, annualRatePct, years) {
    if (principal <= 0) return 0;
    const n = years * 12;
    const r = annualRatePct / 100 / 12;
    if (r === 0) return principal / n;
    return (principal * r) / (1 - Math.pow(1 + r, -n));
  }

  /**
   * Effective note rate for the chosen product.
   * PMMS publishes the 30-yr headline; the rest are conventional spreads,
   * exposed so the user can overwrite them with a real quote.
   */
  function noteRate(market, input) {
    if (input.rateOverride != null && input.rateOverride !== '') {
      return Number(input.rateOverride);
    }
    const m = market.mortgage;
    let rate = m.rate_30yr;
    if (input.term === 15) rate += m.spread_15yr;
    if (input.loanType === 'fha') rate += m.spread_fha;
    if (input.loanType === 'va') rate += m.spread_va;
    return rate;
  }

  /**
   * Loan sizing plus mortgage insurance.
   *
   * The three products behave genuinely differently and the differences are
   * the kind that surprise buyers:
   *   conventional - PMI falls off automatically at 78% LTV
   *   FHA          - upfront MIP is financed into the balance, and annual MIP
   *                  is permanent when LTV > 90% at origination
   *   VA           - no monthly MI at all; a one-time funding fee is financed
   */
  function loanDetail(price, input, market) {
    const down = price * clamp(input.downPct, 0, 1);
    let base = Math.max(0, price - down);
    const ltv = price > 0 ? base / price : 0;
    const rate = noteRate(market, input);

    let financedFee = 0;
    let monthlyMI = 0;
    let miNote = '';
    let miEndsMonth = null;

    if (input.loanType === 'fha') {
      financedFee = base * 0.0175; // upfront MIP
      const annual = ltv > 0.9 ? 0.0055 : 0.005;
      monthlyMI = ((base + financedFee) * annual) / 12;
      if (ltv > 0.9) {
        miNote = 'FHA MIP for the life of the loan';
      } else {
        miNote = 'FHA MIP for 11 years';
        miEndsMonth = 132;
      }
    } else if (input.loanType === 'va') {
      financedFee = base * 0.0215; // first-use funding fee
      miNote = 'VA: no monthly mortgage insurance';
    } else if (ltv > 0.8) {
      const annual = input.pmiPct / 100;
      monthlyMI = (base * annual) / 12;
      // PMI must terminate automatically at 78% LTV on the original schedule.
      const target = price * 0.78;
      let bal = base;
      const r = rate / 100 / 12;
      const pay = amortize(base, rate, input.term);
      for (let m = 1; m <= input.term * 12; m++) {
        bal = bal * (1 + r) - pay;
        if (bal <= target) { miEndsMonth = m; break; }
      }
      miNote = 'PMI drops off at 78% LTV (month ' + (miEndsMonth ?? '—') + ')';
    }

    const principal = base + financedFee;
    return {
      down, principal, rate, ltv, financedFee, monthlyMI, miNote, miEndsMonth,
      monthlyPI: amortize(principal, rate, input.term),
    };
  }

  /* ---------------------------------------------------------------------
   * Insurance
   * ------------------------------------------------------------------ */

  /**
   * Modelled annual premium. No free per-ZIP insurance API exists, so this is
   * a transparent scaling of the published state average — labelled an estimate
   * everywhere it surfaces, and overridable with a real quote.
   */
  function insurance(zone, input, market) {
    if (input.insuranceOverride != null && input.insuranceOverride !== '') {
      return Number(input.insuranceOverride);
    }
    const ins = market.insurance;
    const factor = ins.county_factor[zone.county] ?? 1.0;
    // Based on purchase price, not appraised value: dwelling coverage tracks
    // what it costs to rebuild, which follows the market rather than the
    // appraisal district's figure. Identical whenever the two are set equal.
    const dwelling = (input.price || input.assessedValue) * clamp(input.dwellingPct, 0.3, 1.2);
    const est = ins.state_avg_annual * (dwelling / ins.state_avg_dwelling) * factor;
    return Math.max(ins.min_annual, est);
  }

  /* ---------------------------------------------------------------------
   * Total cost of ownership
   * ------------------------------------------------------------------ */

  /** Full monthly picture for one zone at one price. */
  function monthly(zone, input, market) {
    const rules = market.exemptions[input.state || 'TX'];
    const tax = propertyTax(zone, input, rules);
    const loan = loanDetail(input.price, input, market);
    const ins = insurance(zone, input, market);

    const parts = {
      principalInterest: loan.monthlyPI,
      tax: tax.total / 12,
      insurance: ins / 12,
      mortgageInsurance: loan.monthlyMI,
      hoa: input.hoaMonthly || 0,
    };
    const total = Object.values(parts).reduce((s, v) => s + v, 0);
    return {
      total, parts, loan,
      taxAnnual: tax.total,
      taxLines: tax.lines,
      insuranceAnnual: ins,
      effectiveTaxRate: input.assessedValue > 0
        ? (tax.total / input.assessedValue) * 100
        : 0,
    };
  }

  /**
   * Invert monthly() — the largest price whose all-in payment fits a budget.
   *
   * Bisection rather than algebra: exemptions, the PMI threshold and the
   * insurance floor make the price→payment curve piecewise, so a closed form
   * would be wrong at exactly the boundaries buyers care about.
   */
  function affordablePrice(zone, input, market, budget) {
    let lo = 0, hi = 3_000_000;
    const at = (p) => monthly(
      zone,
      { ...input, price: p, assessedValue: p * (input.assessedRatio ?? 1) },
      market
    ).total;
    if (at(lo) > budget) return 0;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid) <= budget) lo = mid; else hi = mid;
    }
    return lo;
  }

  /**
   * Multi-year projection.
   *
   * Year one alone flatters Texas badly. A homestead caps appraisal growth at
   * 10%/yr, but that cap resets on sale, and insurance has been climbing far
   * faster than wages. Both compound, so the gap between year 1 and year 10 is
   * where the real cost of a zone shows up.
   */
  function project(zone, input, market, years) {
    const rules = market.exemptions[input.state || 'TX'];
    const rows = [];
    let assessed = input.assessedValue;
    let ins = insurance(zone, input, market);
    const loan = loanDetail(input.price, input, market);
    const pi = loan.monthlyPI * 12;
    let cumulative = 0;

    for (let y = 1; y <= years; y++) {
      if (y > 1) {
        const growth = input.appreciationPct / 100;
        const capped = input.homestead
          ? Math.min(1 + growth, 1 + rules.appraisal_cap_pct)
          : 1 + growth;
        assessed *= capped;
        ins *= 1 + input.insuranceInflationPct / 100;
      }
      const tax = propertyTax(zone, { ...input, assessedValue: assessed }, rules).total;
      const mi = loan.miEndsMonth && y * 12 > loan.miEndsMonth ? 0 : loan.monthlyMI * 12;
      const hoa = (input.hoaMonthly || 0) * 12;
      const total = pi + tax + ins + mi + hoa;
      cumulative += total;
      rows.push({
        year: y,
        assessed: round2(assessed),
        tax: round2(tax),
        insurance: round2(ins),
        pi: round2(pi),
        mi: round2(mi),
        hoa: round2(hoa),
        total: round2(total),
        monthly: round2(total / 12),
        cumulative: round2(cumulative),
      });
    }
    return rows;
  }

  global.Engine = {
    propertyTax, loanDetail, insurance, monthly,
    affordablePrice, project, amortize, noteRate,
  };
})(window);
