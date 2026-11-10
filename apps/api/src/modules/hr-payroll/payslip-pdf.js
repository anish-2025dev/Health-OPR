import PDFDocument from 'pdfkit';
import { amountInWords } from './engine.js';

const inr = (amount) => {
  const [r, p] = String(amount).replace('-', '').split('.');
  const last3 = r.slice(-3);
  const rest = r.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${String(amount).startsWith('-') ? '-' : ''}${grouped}.${p ?? '00'}`;
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export const periodLabel = (start) =>
  `${MONTHS[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`;

/**
 * Renders a payslip PDF from an item's immutable calculation snapshot. Returns a Buffer.
 * Uses only the stored snapshot, so a re-download always matches what was approved.
 */
export function renderPayslip({ organization, item, run }) {
  const s = item.calculation_snapshot;
  const r = s.result;
  const m = s.inputs.metrics;
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: { Title: `Payslip ${periodLabel(s.period.start)}` },
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width - 80;
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#134e4a').text(organization.name, 40, 40);
  if (organization.legalName)
    doc.font('Helvetica').fontSize(9).fillColor('#475569').text(organization.legalName);
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#0f172a')
    .text(`Payslip for ${periodLabel(s.period.start)}`, 40, 40, { align: 'right', width: W });
  doc
    .moveTo(40, 80)
    .lineTo(40 + W, 80)
    .strokeColor('#cbd5e1')
    .stroke();

  // Employee details
  const details = [
    ['Employee', `${s.employee.fullName} (${s.employee.employeeNumber})`],
    ['Department', s.employee.department ?? '—'],
    ['Designation', s.employee.designation ?? '—'],
    ['Branch', s.employee.branch],
    ['Date of joining', s.employee.joiningDate],
    ['Pay period', `${s.period.start} to ${s.period.end}`],
  ];
  const attendance = [
    ['Days in period', String(m.daysInPeriod)],
    ['Working days', String(m.workingDays)],
    ['Loss of pay days', String(m.lopDays)],
    ['Paid leave days', String(m.paidLeaveDays)],
    ['Late arrivals', String(m.lateCount)],
    ['Day rate', `${inr(r.dayRate)} (${s.inputs.settings.dayRateBasis.replace('_', ' ')})`],
  ];
  let y = 92;
  doc.fontSize(9);
  for (let i = 0; i < details.length; i++) {
    doc.font('Helvetica').fillColor('#64748b').text(details[i][0], 40, y, { width: 90 });
    doc.font('Helvetica').fillColor('#0f172a').text(details[i][1], 130, y, { width: 160 });
    doc.font('Helvetica').fillColor('#64748b').text(attendance[i][0], 310, y, { width: 100 });
    doc.font('Helvetica').fillColor('#0f172a').text(attendance[i][1], 410, y, { width: 145 });
    y += 16;
  }

  // Earnings and deductions tables side by side
  y += 12;
  const colW = W / 2 - 10;
  const table = (x, title, lines, total, totalLabel) => {
    let ty = y;
    doc.rect(x, ty, colW, 20).fill('#f0fdfa');
    doc
      .fillColor('#134e4a')
      .font('Helvetica-Bold')
      .fontSize(10)
      .text(title, x + 8, ty + 6, { width: colW - 90 });
    doc.text('Amount (INR)', x + colW - 88, ty + 6, { width: 80, align: 'right' });
    ty += 24;
    doc.font('Helvetica').fontSize(9).fillColor('#0f172a');
    for (const l of lines) {
      doc.text(l.label, x + 8, ty, { width: colW - 100 });
      const h = doc.heightOfString(l.label, { width: colW - 100 });
      doc.text(inr(l.amount), x + colW - 88, ty, { width: 80, align: 'right' });
      if (l.detail) {
        doc
          .fillColor('#94a3b8')
          .fontSize(7)
          .text(l.detail, x + 8, ty + h, { width: colW - 100 });
        ty += doc.heightOfString(l.detail, { width: colW - 100 });
        doc.fillColor('#0f172a').fontSize(9);
      }
      ty += h + 6;
    }
    return {
      ty,
      draw: (atY) => {
        doc
          .moveTo(x, atY)
          .lineTo(x + colW, atY)
          .strokeColor('#cbd5e1')
          .stroke();
        doc.font('Helvetica-Bold').text(totalLabel, x + 8, atY + 6);
        doc.text(inr(total), x + colW - 88, atY + 6, { width: 80, align: 'right' });
      },
    };
  };
  const earn = table(
    40,
    'Earnings',
    r.lines.filter((l) => l.kind === 'earning'),
    r.grossEarnings,
    'Gross earnings',
  );
  const ded = table(
    40 + colW + 20,
    'Deductions',
    r.lines.filter((l) => l.kind === 'deduction'),
    r.totalDeductions,
    'Total deductions',
  );
  const bottom = Math.max(earn.ty, ded.ty) + 4;
  earn.draw(bottom);
  ded.draw(bottom);

  // Net pay
  y = bottom + 34;
  doc.rect(40, y, W, 46).fill('#134e4a');
  doc
    .fillColor('#ffffff')
    .font('Helvetica-Bold')
    .fontSize(13)
    .text(`Net pay: INR ${inr(r.netPay)}`, 52, y + 9);
  doc
    .font('Helvetica')
    .fontSize(9)
    .text(amountInWords(r.netPay), 52, y + 28, { width: W - 24 });

  y += 64;
  const employer = r.lines.filter((l) => l.kind === 'employer');
  if (employer.length) {
    doc
      .fillColor('#0f172a')
      .font('Helvetica-Bold')
      .fontSize(9)
      .text('Employer contributions (not deducted from your pay)', 40, y);
    y += 14;
    doc.font('Helvetica').fontSize(9);
    for (const l of employer) {
      doc.text(l.label, 52, y, { width: W - 140 });
      doc.text(inr(l.amount), 40 + W - 120, y, { width: 120, align: 'right' });
      y += 13;
    }
    y += 8;
  }
  doc.fillColor('#64748b').fontSize(8);
  const paid =
    item.payment_status === 'paid'
      ? `Paid${item.paid_at ? ` on ${new Date(item.paid_at).toISOString().slice(0, 10)}` : ''}`
      : 'Payment status: pending';
  doc.text(
    `${paid}. Approved on ${run.approved_at ? new Date(run.approved_at).toISOString().slice(0, 10) : '—'}.`,
    40,
    y,
  );
  doc.text(
    "This is a computer-generated payslip based on recorded attendance, leave and the company's configured pay rules. Statutory deductions appear only where configured and approved by the employer.",
    40,
    y + 12,
    { width: W },
  );
  doc.text(`Calculation reference: ${item.id} · ${s.engineVersion}`, 40, y + 36, { width: W });
  doc.end();
  return done;
}
