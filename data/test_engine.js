/**
 * Engine verification against hand-computed figures.
 * Run: node data/test_engine.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'web');
global.window = global;
eval(fs.readFileSync(path.join(root, 'js', 'engine.js'), 'utf8'));
const MARKET = JSON.parse(fs.readFileSync(path.join(root, 'data', 'market.json'), 'utf8'));
const ZONES = JSON.parse(fs.readFileSync(path.join(root, 'data', 'zones.geojson'), 'utf8'));

let pass = 0, fail = 0;
function eq(label, got, want, tol = 0.02) {
  const ok = Math.abs(got - want) <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got ${got.toFixed(4)}  want ${want.toFixed(4)}`);
  ok ? pass++ : fail++;
}
function ok(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
  cond ? pass++ : fail++;
}

const zone = ZONES.features.find(
  (f) => f.properties.isd.startsWith('San Antonio') &&
         f.properties.city === 'San Antonio' &&
         f.properties.county === 'Bexar'
).properties;

const base = {
  state: 'TX', price: 400000, assessedValue: 400000, assessedRatio: 1,
  downPct: 0.20, term: 30, loanType: 'conventional', rateOverride: '',
  pmiPct: 0.5, homestead: true, senior: false, localOptionalPct: 0.20,
  hoaMonthly: 0, specialRate: 0, insuranceOverride: '', dwellingPct: 0.85,
  appreciationPct: 3, insuranceInflationPct: 8,
};

console.log('\n=== SAISD / San Antonio / Bexar — $400,000, 20% down, homestead ===\n');

// Property tax, hand-computed per unit.
const tax = Engine.propertyTax(zone, base, MARKET.exemptions.TX);
eq('school tax  (260,000 x 1.1552)', tax.lines[0].amount, 3003.52);
eq('county tax  (320,000 x 0.299999)', tax.lines.find((l) => l.kind === 'county').amount, 959.9968);
eq('city tax    (320,000 x 0.54159)', tax.lines.find((l) => l.kind === 'city').amount, 1733.088);
eq('annual property tax total', tax.total, 7116.3968);

const m = Engine.monthly(zone, base, MARKET);
eq('effective tax rate %', m.effectiveTaxRate, 1.77910, 0.0001);
eq('monthly P&I @ 6.67% / 30yr on 320,000', m.loan.monthlyPI, 2058.33, 0.5);
eq('annual insurance (4350 x 340k/300k)', m.insuranceAnnual, 4930.0, 1);
eq('total monthly', m.total, 3062.19, 1);

console.log('\n=== Exemption behaviour ===\n');
// Unexempted bill: 400,000 against every unit = $9,761.896.
// Exempted bill: $7,116.3968. The homestead is worth the difference.
const noHs = Engine.monthly(zone, { ...base, homestead: false }, MARKET);
eq('unexempted annual tax', noHs.taxAnnual, 9761.896);
eq('homestead saves per year', noHs.taxAnnual - m.taxAnnual, 2645.4992);
const senior = Engine.propertyTax(zone, { ...base, senior: true }, MARKET.exemptions.TX);
eq('senior extra 60k off school (x 1.1552)',
   tax.lines[0].amount - senior.lines[0].amount, 693.12, 0.5);

console.log('\n=== Mortgage insurance rules ===\n');
const low = Engine.loanDetail(400000, { ...base, downPct: 0.05 }, MARKET);
ok('5% down triggers PMI', low.monthlyMI > 0, `$${low.monthlyMI.toFixed(2)}/mo`);
ok('PMI terminates on schedule', low.miEndsMonth > 0 && low.miEndsMonth < 360,
   `month ${low.miEndsMonth}`);
const exact20 = Engine.loanDetail(400000, { ...base, downPct: 0.20 }, MARKET);
ok('20% down has no PMI', exact20.monthlyMI === 0);
const fha = Engine.loanDetail(400000, { ...base, downPct: 0.035, loanType: 'fha' }, MARKET);
ok('FHA finances upfront MIP', fha.principal > 400000 * 0.965,
   `principal $${fha.principal.toFixed(0)} > base $${(400000 * 0.965).toFixed(0)}`);
ok('FHA MIP is permanent below 10% down', fha.miEndsMonth === null, fha.miNote);
const va = Engine.loanDetail(400000, { ...base, downPct: 0, loanType: 'va' }, MARKET);
ok('VA carries no monthly MI', va.monthlyMI === 0);

console.log('\n=== Affordability inversion round-trips ===\n');
const budget = 3200;
const p = Engine.affordablePrice(zone, base, MARKET, budget);
const back = Engine.monthly(
  zone, { ...base, price: p, assessedValue: p }, MARKET
).total;
eq(`price for $${budget}/mo re-priced`, back, budget, 1);
console.log(`        -> ${'$' + Math.round(p).toLocaleString()} affordable here`);

console.log('\n=== Projection ===\n');
const proj = Engine.project(zone, base, MARKET, 10);
ok('homestead caps appraisal growth at 10%',
   proj[1].assessed <= base.assessedValue * 1.10 + 0.01,
   `yr2 $${proj[1].assessed.toLocaleString()}`);
ok('cumulative cost increases monotonically',
   proj.every((r, i) => i === 0 || r.cumulative > proj[i - 1].cumulative));
ok('year 10 monthly exceeds year 1',
   proj[9].monthly > proj[0].monthly,
   `$${proj[0].monthly.toFixed(0)} -> $${proj[9].monthly.toFixed(0)}`);

console.log('\n=== Cross-zone sanity ===\n');
const all = ZONES.features.map((f) => f.properties);
ok('every zone has a positive total rate', all.every((z) => z.total_rate > 0));
ok('rate stack sums to stored total', all.every((z) => {
  const s = z.rates.county + z.rates.city + z.rates.school +
            z.rates.countywide.reduce((a, c) => a + c.rate, 0);
  return Math.abs(s - z.total_rate) < 1e-6;
}));
const mud = { ...base, specialRate: 1.0 };
eq('Redbird-style MUD at 1.00/$100 adds',
   Engine.monthly(zone, mud, MARKET).taxAnnual - m.taxAnnual, 4000, 1);

/* ------------------------------------------------------------------------
 * Cash to close
 * --------------------------------------------------------------------- */
console.log('\n=== Cash to close — $340,000, 20% down, June close ===\n');

const closingBase = {
  ...base,
  price: 340000,
  assessedValue: 340000,
  closing: {
    closingMonth: 6, sellerCredit: 0, originationPct: 1, lenderTitle: 325,
    appraisal: 600, survey: 550, escrowFee: 650, recording: 250,
    hoaTransfer: 0, buyerAgentPct: 0,
  },
};
const c6 = Engine.cashToClose(zone, closingBase, MARKET);
const tax340 = Engine.propertyTax(zone, closingBase, MARKET.exemptions.TX).total;
const ins340 = Engine.insurance(zone, closingBase, MARKET);

eq('down payment (20% of 340k)', c6.downPayment, 68000);
eq('origination (1% of 272k loan)', c6.fees[0].amount, 2720);
eq('fixed fees sum', c6.feesTotal - 2720, 325 + 600 + 550 + 650 + 250);
// June close: 6 payments land before the 31 Jan due date, so the lender needs
// 12 - 6 + 2 cushion = 8 months on deposit.
eq('tax escrow = 8 months', c6.prepaids[2].amount, (tax340 / 12) * 8, 0.5);
eq('insurance escrow = 2 months', c6.prepaids[1].amount, (ins340 / 12) * 2, 0.5);
eq('year-1 insurance paid in full', c6.prepaids[0].amount, ins340, 0.5);
eq('seller proration = 5.5 months', c6.credits[0].amount, tax340 * 5.5 / 12, 0.5);
ok('cash exceeds down payment', c6.total > c6.downPayment,
   `$${Math.round(c6.total).toLocaleString()} vs $68,000 down`);
console.log(`        -> ${c6.pctOfPrice.toFixed(1)}% of price, ` +
            `$${Math.round(c6.total - c6.downPayment).toLocaleString()} beyond the down payment`);

console.log('\n=== Closing month behaves correctly ===\n');
const at = (mo) => Engine.cashToClose(
  zone, { ...closingBase, closing: { ...closingBase.closing, closingMonth: mo } }, MARKET);
const jan = at(1), nov = at(11);
ok('later close raises the tax escrow deposit',
   nov.prepaids[2].amount > jan.prepaids[2].amount,
   `Jan $${Math.round(jan.prepaids[2].amount)} -> Nov $${Math.round(nov.prepaids[2].amount)}`);
ok('later close raises the seller credit',
   nov.credits[0].amount > jan.credits[0].amount,
   `Jan $${Math.round(jan.credits[0].amount)} -> Nov $${Math.round(nov.credits[0].amount)}`);
ok('the two largely offset (net swing under 12% of one year of tax)',
   Math.abs((nov.total - jan.total)) < tax340 * 0.12,
   `net Jan $${Math.round(jan.total).toLocaleString()} vs Nov $${Math.round(nov.total).toLocaleString()}`);

console.log('\n=== Credits and options ===\n');
const credited = Engine.cashToClose(
  zone, { ...closingBase, closing: { ...closingBase.closing, sellerCredit: 10000 } }, MARKET);
eq('a $10,000 builder credit reduces cash 1:1', c6.total - credited.total, 10000, 0.5);
const withAgent = Engine.cashToClose(
  zone, { ...closingBase, closing: { ...closingBase.closing, buyerAgentPct: 2.5 } }, MARKET);
eq('paying your own agent at 2.5%', withAgent.total - c6.total, 340000 * 0.025, 0.5);
const vaCash = Engine.cashToClose(
  zone, { ...closingBase, downPct: 0, loanType: 'va' }, MARKET);
ok('VA funding fee is financed, not paid at the table', vaCash.financedFee > 0,
   `$${Math.round(vaCash.financedFee).toLocaleString()} rolled into the loan`);
ok('cash to close never goes negative',
   Engine.cashToClose(zone, { ...closingBase, closing: { ...closingBase.closing, sellerCredit: 999999 } }, MARKET).total === 0);

console.log(`
${pass} passed, ${fail} failed
`);
process.exit(fail ? 1 : 0);
