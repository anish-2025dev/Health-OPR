/**
 * Statutory payroll calculations (pure, unit-tested in tests/statutory-calc.test.js).
 *
 * Every rate, ceiling, slab and month comes from rules the organization entered and approved; nothing
 * statutory is hardcoded here. Amounts are computed on earned wages (after loss of pay) in exact paise.
 */
import { z } from 'zod';
import {
  componentAmounts,
  decimalFraction,
  fromPaise,
  mulDivRound,
  toPaise,
} from '../hr-payroll/engine.js';

const MONEY = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Amount like 15000 or 15000.50');
const PERCENT = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Percent like 12 or 0.75');
const CODES = z
  .array(z.string().regex(/^[A-Z0-9_]{1,16}$/))
  .min(1)
  .max(20);
const ROUNDING = z.enum(['none', 'nearest_rupee', 'up_rupee']);
const MONTHS = z.array(z.number().int().min(1).max(12)).max(12);

export const RULE_CONFIG_SCHEMAS = {
  epf: z
    .object({
      employeeRatePercent: PERCENT,
      employerRatePercent: PERCENT,
      wageComponentCodes: CODES,
      wageCeiling: MONEY.nullable(),
      rounding: ROUNDING,
    })
    .strict(),
  esi: z
    .object({
      employeeRatePercent: PERCENT,
      employerRatePercent: PERCENT,
      eligibilityGrossCeiling: MONEY.nullable(),
      rounding: ROUNDING,
    })
    .strict(),
  professional_tax: z
    .object({
      slabs: z
        .array(z.object({ fromGross: MONEY, toGross: MONEY.nullable(), amount: MONEY }).strict())
        .min(1)
        .max(20),
      monthOverrides: z
        .array(z.object({ month: z.number().int().min(1).max(12), amount: MONEY }).strict())
        .max(12)
        .default([]),
    })
    .strict(),
  lwf: z.object({ employeeAmount: MONEY, employerAmount: MONEY, months: MONTHS.min(1) }).strict(),
  gratuity: z
    .object({
      daysPerYear: z.number().positive().max(60),
      divisorDays: z.number().int().min(1).max(31),
      minServiceYears: z.number().min(0).max(20),
      wageComponentCodes: CODES,
    })
    .strict(),
};

const round = (paise, mode) => {
  if (mode === 'nearest_rupee') return ((paise + 50n) / 100n) * 100n;
  if (mode === 'up_rupee') return ((paise + 99n) / 100n) * 100n;
  return paise;
};

const pct = (base, percent, rounding) => {
  const f = decimalFraction(percent);
  return round(mulDivRound([base, f.num], [100n, f.den]), rounding);
};

/** Earned share of a monthly amount after loss of pay: amount × (divisor − lop) / divisor. */
export function earned(amount, divisor, lopDays) {
  if (!divisor) return amount;
  const paidHalves = BigInt(Math.max(0, Math.round((divisor - lopDays) * 2)));
  return mulDivRound([amount, paidHalves], [divisor, 2]);
}

/** The approved rule in force at `date` for a type and jurisdiction (latest effective_from wins). */
export function ruleInForce(rules, type, jurisdiction, date) {
  return rules
    .filter(
      (r) =>
        r.ruleType === type &&
        r.jurisdiction === jurisdiction &&
        r.approvalStatus === 'approved' &&
        r.effectiveFrom <= date &&
        (!r.effectiveTo || r.effectiveTo >= date),
    )
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
}

/**
 * Statutory lines for one employee and period.
 * @returns {{ lines: Array, rules: Array }} lines use kind 'deduction' (employee share) or
 *   'employer' (employer share; shown on the payslip but not deducted from pay).
 */
export function computeStatutory({
  rules,
  statutory,
  components,
  structureAmounts,
  metrics,
  settings,
  periodEnd,
}) {
  const lines = [];
  const used = [];
  if (!statutory) return { lines, rules: used };
  const month = Number(periodEnd.slice(5, 7));
  const divisor =
    settings.dayRateBasis === 'fixed_days'
      ? Number(settings.fixedDays)
      : settings.dayRateBasis === 'working_days'
        ? metrics.workingDays
        : metrics.daysInPeriod;

  const amounts = componentAmounts(components, structureAmounts);
  const byCode = new Map(components.map((c) => [c.code, c]));
  const earnings = components.filter((c) => c.kind === 'earning' && amounts.has(c.id));
  const monthlyGross = earnings.reduce((a, c) => a + amounts.get(c.id), 0n);
  const earnedGross = earnings.reduce(
    (a, c) => a + earned(amounts.get(c.id), divisor, metrics.lopDays),
    0n,
  );
  const earnedOf = (codes) =>
    codes.reduce((a, code) => {
      const c = byCode.get(code);
      return c && amounts.has(c.id) ? a + earned(amounts.get(c.id), divisor, metrics.lopDays) : a;
    }, 0n);
  const note = (r) => ({
    id: r.id,
    type: r.ruleType,
    jurisdiction: r.jurisdiction,
    effectiveFrom: r.effectiveFrom,
    sourceReference: r.sourceReference,
  });

  // Provident fund
  const epf = statutory.pfApplicable && ruleInForce(rules, 'epf', 'IN', periodEnd);
  if (epf) {
    const cfg = epf.config;
    let wage = earnedOf(cfg.wageComponentCodes);
    if (cfg.wageCeiling && wage > toPaise(cfg.wageCeiling)) wage = toPaise(cfg.wageCeiling);
    const ee = pct(wage, cfg.employeeRatePercent, cfg.rounding);
    const er = pct(wage, cfg.employerRatePercent, cfg.rounding);
    const detail = `${cfg.employeeRatePercent}% of PF wages ${fromPaise(wage)}`;
    if (ee > 0n)
      lines.push({
        kind: 'deduction',
        code: 'PF_EE',
        label: 'Provident fund (employee)',
        amount: fromPaise(ee),
        detail,
      });
    if (er > 0n)
      lines.push({
        kind: 'employer',
        code: 'PF_ER',
        label: 'Provident fund (employer)',
        amount: fromPaise(er),
        detail: `${cfg.employerRatePercent}% of PF wages ${fromPaise(wage)}`,
      });
    used.push(note(epf));
  }

  // Employees' State Insurance
  const esi = statutory.esiApplicable && ruleInForce(rules, 'esi', 'IN', periodEnd);
  if (esi) {
    const cfg = esi.config;
    const eligible =
      !cfg.eligibilityGrossCeiling || monthlyGross <= toPaise(cfg.eligibilityGrossCeiling);
    if (eligible) {
      const ee = pct(earnedGross, cfg.employeeRatePercent, cfg.rounding);
      const er = pct(earnedGross, cfg.employerRatePercent, cfg.rounding);
      if (ee > 0n)
        lines.push({
          kind: 'deduction',
          code: 'ESI_EE',
          label: 'ESI (employee)',
          amount: fromPaise(ee),
          detail: `${cfg.employeeRatePercent}% of gross ${fromPaise(earnedGross)}`,
        });
      if (er > 0n)
        lines.push({
          kind: 'employer',
          code: 'ESI_ER',
          label: 'ESI (employer)',
          amount: fromPaise(er),
          detail: `${cfg.employerRatePercent}% of gross ${fromPaise(earnedGross)}`,
        });
    }
    used.push(note(esi));
  }

  // Professional tax (state slabs on earned gross)
  const pt =
    statutory.ptState && ruleInForce(rules, 'professional_tax', statutory.ptState, periodEnd);
  if (pt) {
    const slab = pt.config.slabs.find(
      (s) =>
        earnedGross >= toPaise(s.fromGross) &&
        (s.toGross === null || earnedGross <= toPaise(s.toGross)),
    );
    let amount = slab ? toPaise(slab.amount) : 0n;
    const override = (pt.config.monthOverrides ?? []).find((o) => o.month === month);
    if (override && amount > 0n) amount = toPaise(override.amount);
    if (amount > 0n)
      lines.push({
        kind: 'deduction',
        code: 'PT',
        label: `Professional tax (${statutory.ptState})`,
        amount: fromPaise(amount),
        detail: `Slab for gross ${fromPaise(earnedGross)}`,
      });
    used.push(note(pt));
  }

  // Labour welfare fund (state, only in configured months)
  const lwf =
    statutory.lwfApplicable &&
    statutory.ptState &&
    ruleInForce(rules, 'lwf', statutory.ptState, periodEnd);
  if (lwf && lwf.config.months.includes(month)) {
    const ee = toPaise(lwf.config.employeeAmount);
    const er = toPaise(lwf.config.employerAmount);
    if (ee > 0n)
      lines.push({
        kind: 'deduction',
        code: 'LWF_EE',
        label: 'Labour welfare fund (employee)',
        amount: fromPaise(ee),
        detail: null,
      });
    if (er > 0n)
      lines.push({
        kind: 'employer',
        code: 'LWF_ER',
        label: 'Labour welfare fund (employer)',
        amount: fromPaise(er),
        detail: null,
      });
    used.push(note(lwf));
  }

  // Income tax deducted at source: monthly amount set by payroll.
  if (statutory.tdsMonthlyAmount && toPaise(statutory.tdsMonthlyAmount) > 0n) {
    lines.push({
      kind: 'deduction',
      code: 'TDS',
      label: 'Income tax (TDS)',
      amount: fromPaise(toPaise(statutory.tdsMonthlyAmount)),
      detail: 'Monthly amount set by payroll',
    });
  }

  return { lines, rules: used };
}

/**
 * Gratuity liability estimate (tracking only, not a deduction):
 * last wages × daysPerYear / divisorDays × completed years of service.
 */
export function gratuityEstimate({ rule, components, structureAmounts, joiningDate, asOf }) {
  const cfg = rule.config;
  const amounts = componentAmounts(components, structureAmounts);
  const wages = cfg.wageComponentCodes.reduce((a, code) => {
    const c = components.find((x) => x.code === code);
    return c && amounts.has(c.id) ? a + amounts.get(c.id) : a;
  }, 0n);
  const [jy, jm, jd] = joiningDate.split('-').map(Number);
  const [ay, am, ad] = asOf.split('-').map(Number);
  let years = ay - jy;
  if (am < jm || (am === jm && ad < jd)) years -= 1;
  years = Math.max(0, years);
  const days = decimalFraction(String(cfg.daysPerYear), 2);
  const amount = mulDivRound([wages, days.num, BigInt(years)], [BigInt(cfg.divisorDays), days.den]);
  return {
    completedYears: years,
    wages: fromPaise(wages),
    eligible: years >= cfg.minServiceYears,
    estimatedAmount: fromPaise(amount),
  };
}
