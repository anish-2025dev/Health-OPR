/**
 * Payroll calculation engine: pure functions, no I/O (unit-tested in tests/payroll-engine.test.js).
 *
 * Money is handled in integer paise with exact rational arithmetic (BigInt), rounded half-up to the
 * paisa only once per line. Inputs and outputs use decimal strings ("12345.67"), never JS floats.
 * Every value used is recorded on the line, so a payslip can be explained and reproduced.
 */

export const ENGINE_VERSION = 'payroll-engine/1';

// ------------------------------------------------------------------ exact arithmetic

/** "12345.6" -> 1234560n (paise). */
export function toPaise(value) {
  const s = String(value ?? '0').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid money amount: ${s}`);
  const negative = s.startsWith('-');
  const [rupees, paise = ''] = s.replace('-', '').split('.');
  const v = BigInt(rupees) * 100n + BigInt(paise.padEnd(2, '0'));
  return negative ? -v : v;
}

/** 1234560n -> "12345.60" */
export function fromPaise(p) {
  const negative = p < 0n;
  const abs = negative ? -p : p;
  const s = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return negative ? `-${s}` : s;
}

/** Fraction from a decimal string/number with up to `scale` decimals: "12.5" -> { num: 125n, den: 10n }. */
export function decimalFraction(value, scale = 4) {
  const s = String(value);
  const [i, f = ''] = s.split('.');
  const digits = f.slice(0, scale);
  return { num: BigInt(`${i}${digits}`), den: 10n ** BigInt(digits.length) };
}

/** round_half_up(Π nums / Π dens) as BigInt paise. */
export function mulDivRound(nums, dens) {
  const n = nums.reduce((a, b) => a * BigInt(b), 1n);
  const d = dens.reduce((a, b) => a * BigInt(b), 1n);
  if (d === 0n) return 0n;
  const negative = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an * 2n + ad) / (ad * 2n);
  return negative ? -q : q;
}

/** Day counts are multiples of 0.5: represent as halves. */
const halves = (days) => BigInt(Math.round(Number(days) * 2));

// ------------------------------------------------------------------ attendance -> payroll metrics

/**
 * Converts an attendance month (from the attendance service, with leave overlaid) into payroll metrics.
 * Loss of pay (LOP) days:
 * - absent day: 1; not yet employed / already left: 1
 * - missed check-out: settings.incompleteDayLop; reduced hours: settings.reducedHoursLop
 * - half day: 0.5 (0 if the other half is paid leave)
 * - leave: paid leave covers its fraction; unpaid leave counts as LOP; an uncovered half counts 0.5
 * - present, week off, holiday: 0
 */
export function attendanceMetrics(month, settings) {
  const m = {
    daysInPeriod: month.days.length,
    workingDays: 0,
    lopDays: 0,
    absentDays: 0,
    halfDays: 0,
    incompleteDays: 0,
    reducedHourDays: 0,
    notEmployedDays: 0,
    paidLeaveDays: 0,
    unpaidLeaveDays: 0,
    presentDays: 0,
    weekOffDays: 0,
    holidayDays: 0,
    overtimeMinutes: month.summary.overtimeMinutes,
    lateCount: month.latePenalty.lateCount,
    lateBeyondFree: month.latePenalty.penalizedLates,
    incompletePeriod: false,
  };
  const incompleteLop = Number(settings.incompleteDayLop);
  const reducedLop = Number(settings.reducedHoursLop);
  for (const d of month.days) {
    if (!d.isHoliday && !d.isWeekOff) m.workingDays += 1;
    const leave = d.leave;
    const leaveFraction = leave ? leave.fraction : 0;
    if (leave) {
      if (leave.isPaid) m.paidLeaveDays += leaveFraction;
      else m.unpaidLeaveDays += leaveFraction;
    }
    switch (d.status) {
      case 'not_employed':
        m.notEmployedDays += 1;
        m.lopDays += 1;
        break;
      case 'absent':
        m.absentDays += 1;
        m.lopDays += 1;
        break;
      case 'incomplete':
        m.incompleteDays += 1;
        m.lopDays += incompleteLop;
        break;
      case 'reduced_hours':
        m.reducedHourDays += 1;
        m.lopDays += reducedLop;
        break;
      case 'half_day':
        m.halfDays += 1;
        m.lopDays += leave?.isPaid && leaveFraction >= 0.5 ? 0 : 0.5;
        break;
      case 'leave':
        // Paid leave covers its fraction; unpaid leave and any uncovered half are loss of pay.
        m.lopDays += leave?.isPaid ? 1 - leaveFraction : 1;
        break;
      case 'present':
        m.presentDays += 1;
        break;
      case 'week_off':
        m.weekOffDays += 1;
        break;
      case 'holiday':
        m.holidayDays += 1;
        break;
      case 'upcoming':
      case 'not_checked_in':
      case 'checked_in':
        m.incompletePeriod = true;
        break;
      default:
        break;
    }
  }
  return m;
}

// ------------------------------------------------------------------ payslip

/** Monthly amount per component (paise): fixed amounts from the structure, then % of a fixed component. */
export function componentAmounts(components, structureAmounts) {
  const map = new Map();
  for (const c of components.filter((x) => x.calc === 'fixed')) {
    if (structureAmounts[c.id] !== undefined) map.set(c.id, toPaise(structureAmounts[c.id]));
  }
  for (const c of components.filter((x) => x.calc === 'percent_of_component')) {
    const base = map.get(c.baseComponentId);
    if (base === undefined) continue;
    const pct = decimalFraction(c.percent);
    map.set(c.id, mulDivRound([base, pct.num], [100n, pct.den]));
  }
  return map;
}

const METRIC_UNITS = {
  lop_days: (m) => ({ num: halves(m.lopDays), den: 2n, label: `${m.lopDays} LOP day(s)` }),
  absent_days: (m) => ({
    num: BigInt(m.absentDays),
    den: 1n,
    label: `${m.absentDays} absent day(s)`,
  }),
  half_days: (m) => ({ num: BigInt(m.halfDays), den: 1n, label: `${m.halfDays} half day(s)` }),
  late_beyond_free: (m) => ({
    num: BigInt(m.lateBeyondFree),
    den: 1n,
    label: `${m.lateBeyondFree} late arrival(s)`,
  }),
  reduced_hour_days: (m) => ({
    num: BigInt(m.reducedHourDays),
    den: 1n,
    label: `${m.reducedHourDays} reduced-hour day(s)`,
  }),
  incomplete_days: (m) => ({
    num: BigInt(m.incompleteDays),
    den: 1n,
    label: `${m.incompleteDays} missed check-out(s)`,
  }),
  overtime_hours: (m) => ({
    num: BigInt(m.overtimeMinutes),
    den: 60n,
    label: `${Math.floor(m.overtimeMinutes / 60)}h ${m.overtimeMinutes % 60}m overtime`,
  }),
};

/**
 * Computes one employee's payslip.
 *
 * @param {object} input
 * @param {Array}  input.components     salary components (id, code, name, kind, calc, percent, baseComponentId, includeInDayRate, displayOrder)
 * @param {object} input.structureAmounts componentId -> "amount" (fixed components in the employee's structure)
 * @param {object} input.settings       { dayRateBasis, fixedDays }
 * @param {object} input.metrics        from attendanceMetrics()
 * @param {object} input.latePenalty    { mode, amount?, deductionDays? } from the attendance policy
 * @param {number} input.fullDayMinutes from the attendance policy (for hourly rates)
 * @param {Array}  input.policies       applicable pay policies, each with { installmentsUsed }
 * @param {Array}  input.adjustments    { kind, label, amount, reason }
 * @param {Array}  input.statutoryLines precomputed statutory lines (Phase 11), { kind, code, label, amount, detail }
 */
export function computePayslip(input) {
  const { components, structureAmounts, settings, metrics, latePenalty, fullDayMinutes } = input;
  const lines = [];
  const warnings = [];
  const byComponent = new Map();

  // 1. Structure components: fixed first, then percentages of a fixed component.
  const ordered = [...components].sort(
    (a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code),
  );
  for (const [id, amount] of componentAmounts(components, structureAmounts))
    byComponent.set(id, amount);
  for (const c of ordered) {
    if (!byComponent.has(c.id)) continue;
    const amount = byComponent.get(c.id);
    if (amount === 0n) continue;
    const base =
      c.calc === 'percent_of_component' ? components.find((x) => x.id === c.baseComponentId) : null;
    lines.push({
      kind: c.kind,
      code: c.code,
      label: c.name,
      amount,
      source: 'structure',
      detail: base ? `${c.percent}% of ${base.name}` : null,
    });
  }

  // 2. Day rate = monthly earnings that count for the day rate / divisor chosen by the company.
  const dayRateBase = components
    .filter((c) => c.kind === 'earning' && c.includeInDayRate && byComponent.has(c.id))
    .reduce((a, c) => a + byComponent.get(c.id), 0n);
  const divisor =
    settings.dayRateBasis === 'fixed_days'
      ? Number(settings.fixedDays)
      : settings.dayRateBasis === 'working_days'
        ? metrics.workingDays
        : metrics.daysInPeriod;
  if (!divisor)
    warnings.push({ code: 'NO_DIVISOR', message: 'Day-rate divisor is zero; LOP not applied' });
  const dayRate = divisor ? mulDivRound([dayRateBase], [divisor]) : 0n;
  const rate = {
    fixed_amount: (p) => ({ num: toPaise(p.amount), den: 1n }),
    day_rate: () => ({ num: dayRateBase, den: BigInt(divisor || 1) }),
    hourly_rate: () => ({ num: dayRateBase * 60n, den: BigInt((divisor || 1) * fullDayMinutes) }),
  };

  // 3. Loss of pay, capped at the day-rate base.
  if (metrics.lopDays > 0 && divisor) {
    let lop = mulDivRound([dayRateBase, halves(metrics.lopDays)], [divisor, 2]);
    if (lop > dayRateBase) lop = dayRateBase;
    lines.push({
      kind: 'deduction',
      code: 'LOP',
      label: 'Loss of pay',
      amount: lop,
      source: 'attendance',
      detail: `${metrics.lopDays} day(s) × ${fromPaise(dayRate)} (${fromPaise(dayRateBase)} ÷ ${divisor})`,
    });
  }

  // 4. Late penalty from the attendance policy.
  if (latePenalty?.mode === 'fixed_amount' && toPaise(latePenalty.amount ?? '0') > 0n) {
    lines.push({
      kind: 'deduction',
      code: 'LATE',
      label: 'Late arrival penalty',
      amount: toPaise(latePenalty.amount),
      source: 'attendance_policy',
      detail: `${latePenalty.penalizedLates} late arrival(s) beyond ${latePenalty.freeAllowed} free`,
    });
  } else if (
    ['half_day_per_n', 'full_day_per_n'].includes(latePenalty?.mode) &&
    latePenalty.deductionDays > 0 &&
    divisor
  ) {
    lines.push({
      kind: 'deduction',
      code: 'LATE',
      label: 'Late arrival deduction',
      amount: mulDivRound([dayRateBase, halves(latePenalty.deductionDays)], [divisor, 2]),
      source: 'attendance_policy',
      detail: `${latePenalty.deductionDays} day(s) for ${latePenalty.penalizedLates} late arrival(s)`,
    });
  }

  // 5. Company pay policies.
  for (const p of input.policies ?? []) {
    let amount;
    let detail;
    if (p.calc === 'fixed') {
      amount = toPaise(p.amount);
    } else if (p.calc === 'percent_of_component') {
      const base = byComponent.get(p.baseComponentId);
      if (base === undefined) continue;
      const pct = decimalFraction(p.percent);
      amount = mulDivRound([base, pct.num], [100n, pct.den]);
      detail = `${p.percent}% of ${components.find((c) => c.id === p.baseComponentId)?.name ?? 'component'}`;
    } else {
      const units = METRIC_UNITS[p.unitMetric](metrics);
      if (units.num === 0n) continue;
      const r = rate[p.unitRate](p);
      const mult = decimalFraction(p.multiplier, 3);
      amount = mulDivRound([units.num, r.num, mult.num], [units.den, r.den, mult.den]);
      detail = `${units.label} × ${p.unitRate.replace('_', ' ')}${Number(p.multiplier) !== 1 ? ` × ${p.multiplier}` : ''}`;
    }
    if (amount === 0n) continue;
    let label = p.name;
    if (p.frequency === 'installments')
      label = `${p.name} (${p.installmentsUsed + 1} of ${p.installments})`;
    lines.push({
      kind: p.kind,
      code: p.code,
      label,
      amount,
      source: 'policy',
      detail: detail ?? null,
      policyId: p.id,
    });
  }

  // 6. Statutory deductions (Phase 11) and manual adjustments.
  for (const s of input.statutoryLines ?? []) {
    lines.push({
      ...s,
      amount: typeof s.amount === 'bigint' ? s.amount : toPaise(s.amount),
      source: 'statutory',
    });
  }
  for (const a of input.adjustments ?? []) {
    lines.push({
      kind: a.kind,
      code: 'ADJ',
      label: a.label,
      amount: toPaise(a.amount),
      source: 'adjustment',
      detail: a.reason,
    });
  }

  const gross = lines.filter((l) => l.kind === 'earning').reduce((a, l) => a + l.amount, 0n);
  const deductions = lines.filter((l) => l.kind === 'deduction').reduce((a, l) => a + l.amount, 0n);
  const net = gross - deductions;
  if (net < 0n) warnings.push({ code: 'NET_NEGATIVE', message: 'Deductions exceed earnings' });
  if (metrics.incompletePeriod)
    warnings.push({ code: 'PERIOD_NOT_COMPLETE', message: 'The pay period has not ended yet' });

  return {
    engineVersion: ENGINE_VERSION,
    lines: lines.map((l) => ({ ...l, amount: fromPaise(l.amount) })),
    grossEarnings: fromPaise(gross),
    totalDeductions: fromPaise(deductions),
    netPay: fromPaise(net),
    dayRate: fromPaise(dayRate),
    dayRateBase: fromPaise(dayRateBase),
    divisor,
    warnings,
  };
}

// ------------------------------------------------------------------ amount in words (Indian system)

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}
function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? twoDigits(rest) : ''].filter(Boolean).join(' ');
}

/** "125430.50" -> "Rupees One Lakh Twenty Five Thousand Four Hundred Thirty and Fifty Paise Only" */
export function amountInWords(amount) {
  const p = toPaise(amount);
  if (p < 0n) return `Minus ${amountInWords(fromPaise(-p))}`;
  let rupees = Number(p / 100n);
  const paise = Number(p % 100n);
  if (rupees === 0 && paise === 0) return 'Rupees Zero Only';
  const parts = [];
  const crore = Math.floor(rupees / 10_000_000);
  rupees %= 10_000_000;
  const lakh = Math.floor(rupees / 100_000);
  rupees %= 100_000;
  const thousand = Math.floor(rupees / 1000);
  rupees %= 1000;
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rupees) parts.push(threeDigits(rupees));
  const words = parts.join(' ');
  return `Rupees ${words || 'Zero'}${paise ? ` and ${twoDigits(paise)} Paise` : ''} Only`;
}
