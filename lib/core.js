// Shared core: course data, pricing, KV order store, Resend email, PDF (invoice/receipt).
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Redis } from '@upstash/redis';
import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';

// Unicode font (Be Vietnam Pro) — embedded so the PDF renders Vietnamese diacritics.
const FONT_DIR = new URL('./fonts/', import.meta.url);
const FONT_REGULAR = readFileSync(new URL('BeVietnamPro-Regular.ttf', FONT_DIR));
const FONT_BOLD = readFileSync(new URL('BeVietnamPro-Bold.ttf', FONT_DIR));

export const RATE = 25600; // USD -> VND

// Bank transfer details — single source of truth for both the email (bankHtml) and the PDF.
export const BANK_DETAILS = {
  vn: { bank: 'VietinBank', account: '60657888', holder: 'Le Tat Thanh' },
  intl: {
    holder: 'Tat Thanh Le', account: '30000001070030',
    ach: '028000024', wire: '021000021', swift: 'CHASUS33',
    bankName: 'JP Morgan Chase Bank, N.A. - 383 Madison Avenue, New York, NY 10179',
  },
};

// Service provider — appears on the Student Training Agreement. Must match WorldFirst account.
export const PROVIDER = {
  legalName: 'Tat Thanh Le',
  tradeName: 'Paxneo Tech',
  address: 'Flat no. 1218, S106 Tay Mo, Nam Tu Liem, Ha Noi, 100000, Vietnam',
  email: 'paxle86@gmail.com',
};
export const TRAINING_DURATION = 'Lifetime access (online, self-paced)';
export const AGREEMENT_FILENAME = 'PAXNEOTECH_Student_Training_Agreement.pdf';
// Every customer-facing email is CC'd here for record-keeping.
export const CUSTOMER_CC = ['noreply@paxneo.net'];
// Contact emails printed on all PDF documents (invoice, receipt, agreement).
export const DOC_EMAILS = ['hotro@paxneo.net', 'paxle86@gmail.com'];

// Canonical (server-side, language-independent) course data — never trust client values.
export const COURSE = {
  'claude-code': { name: 'Mastering AI in Business with Claude Code', usd: 300 },
  'foundations': { name: 'AI Foundations', usd: 13.5 },
  'content':     { name: 'Content Creation with AI', usd: 69 },
  'marketing':   { name: 'AI in Marketing', usd: 149 },
  'automation':  { name: 'AI Automation & Workflow', usd: 199 },
  'excel':       { name: 'AI with Excel', usd: 99 },
};

export function priceOf(courseId, lang) {
  const c = COURSE[courseId];
  if (!c) return { display: '', currency: '', value: 0 };
  if (lang === 'vi') {
    const v = Math.round(c.usd * RATE);
    return { display: v.toLocaleString('en-US') + ' VND', currency: 'VND', value: v };
  }
  const v = c.usd;
  return { display: '$' + (Number.isInteger(v) ? v : v.toFixed(2)) + ' USD', currency: 'USD', value: v };
}

export function courseLink(courseId) {
  let links = {};
  try { links = JSON.parse(process.env.COURSE_LINKS || '{}'); } catch (e) { links = {}; }
  return links[courseId] || '';
}

// ---- KV (Upstash Redis); supports both Vercel-KV and Upstash env var names ----
function redis() {
  return new Redis({
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}
export async function saveOrder(o) {
  const r = redis();
  await r.set('order:' + o.id, o);
  await r.lpush('orders', o.id);
}
export async function listOrders(limit = 200) {
  const r = redis();
  const ids = (await r.lrange('orders', 0, limit - 1)) || [];
  const out = [];
  for (const id of ids) { const o = await r.get('order:' + id); if (o) out.push(o); }
  return out;
}
export async function getOrder(id) { return await redis().get('order:' + id); }
export async function updateOrder(id, patch) {
  const r = redis();
  const o = await r.get('order:' + id);
  if (!o) return null;
  const n = { ...o, ...patch };
  await r.set('order:' + id, n);
  return n;
}

// ---- Email: dual provider, selected by MAIL_PROVIDER ('smtp' = Google Workspace, else Resend) ----
export const MAIL_FROM = 'Paxneo Tech <support@paxneo.net>';
export const useSmtp = () => process.env.MAIL_PROVIDER === 'smtp';
export const mailConfigured = () => (useSmtp() ? !!(process.env.SMTP_USER && process.env.SMTP_PASS) : !!process.env.RESEND_API_KEY);

let _transport;
function transport() {
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false, requireTLS: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return _transport;
}

// Same payload shape for both. SMTP forces `from` to the authenticated mailbox (Gmail rejects
// arbitrary senders) and maps reply_to + base64 attachments to nodemailer; Resend uses payload as-is.
export async function sendEmail(payload) {
  if (useSmtp()) {
    try {
      const info = await transport().sendMail({
        from: MAIL_FROM, to: payload.to, cc: payload.cc, replyTo: payload.reply_to,
        subject: payload.subject, html: payload.html,
        attachments: (payload.attachments || []).map((a) => ({ filename: a.filename, content: a.content, encoding: 'base64' })),
      });
      return { ok: true, body: null, id: info.messageId };
    } catch (e) {
      return { ok: false, body: String((e && e.message) || e) };
    }
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, body: res.ok ? null : await res.text() };
}

// ---- PDF — bilingual: Vietnamese when order.lang === 'vi' (VND), English otherwise (USD).
// Uses an embedded Unicode font so Vietnamese diacritics render correctly.
export async function buildPdf({ kind, order }) {
  const vi = order.lang === 'vi';
  const t = (en, viText) => (vi ? viText : en);
  const receipt = kind === 'RECEIPT';

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([595, 842]);
  const F = await doc.embedFont(FONT_REGULAR, { subset: true });
  const B = await doc.embedFont(FONT_BOLD, { subset: true });
  const ink = rgb(0.09, 0.11, 0.18), muted = rgb(0.5, 0.5, 0.58), accent = rgb(0.42, 0.36, 1);
  const L = 45, R = 550;
  const T = (s, x, y, sz, f = F, c = ink) => page.drawText(String(s || ''), { x, y, size: sz, font: f, color: c });
  const RT = (s, y, sz, f = F, c = ink) => { s = String(s || ''); page.drawText(s, { x: R - f.widthOfTextAtSize(s, sz), y, size: sz, font: f, color: c }); };
  const line = (y) => page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 1, color: rgb(0.85, 0.85, 0.9) });

  // Header
  const brand = 'PAXNEO';
  T(brand, L, 792, 22, B, ink);
  T('TECH', L + B.widthOfTextAtSize(brand, 22), 792, 22, B, accent);
  T(DOC_EMAILS.join('   '), L, 774, 10, F, muted);
  RT(receipt ? t('RECEIPT', 'BIÊN NHẬN') : t('INVOICE', 'HÓA ĐƠN'), 792, 26, B, accent);
  RT(t('No: ', 'Số: ') + order.docNo, 770, 10, F, muted);
  RT(t('Date: ', 'Ngày: ') + order.date, 756, 10, F, muted);

  line(735);
  T(t('BILL TO', 'KHÁCH HÀNG'), L, 712, 10, B, muted);
  T(order.name, L, 694, 13, B, ink);
  T(order.email, L, 678, 11, F, muted);

  // Table
  const ty = 635;
  T(t('DESCRIPTION', 'MÔ TẢ'), L, ty, 10, B, muted);
  RT(t('AMOUNT', 'SỐ TIỀN'), ty, 10, B, muted);
  line(ty - 8);
  T(order.courseName, L, ty - 30, 12, F, ink);
  RT(order.amountDisplay, ty - 30, 12, F, ink);
  line(ty - 46);
  T(t('TOTAL', 'TỔNG CỘNG'), L, ty - 70, 13, B, ink);
  RT(order.amountDisplay, ty - 70, 13, B, accent);

  // Status / instructions
  let y = ty - 120;
  if (receipt) {
    T(t('STATUS: PAID', 'TRẠNG THÁI: ĐÃ THANH TOÁN'), L, y, 13, B, rgb(0.13, 0.6, 0.3));
    T(t('Thank you! Your payment has been received.', 'Cảm ơn bạn! Chúng tôi đã nhận được thanh toán.'), L, y - 20, 11, F, ink);
    if (order.link) {
      T(t('Course access (Google Drive):', 'Truy cập khóa học (Google Drive):'), L, y - 44, 11, B, ink);
      T(order.link, L, y - 60, 9, F, accent);
    }
  } else {
    const { vn, intl } = BANK_DETAILS;
    T(t('STATUS: AWAITING PAYMENT', 'TRẠNG THÁI: CHỜ THANH TOÁN'), L, y, 12, B, rgb(0.8, 0.5, 0.1));
    T(t('Please pay by bank transfer using the details below.', 'Vui lòng thanh toán bằng chuyển khoản theo thông tin dưới đây.'), L, y - 20, 11, F, ink);

    T(t('PAYMENT DETAILS', 'THÔNG TIN THANH TOÁN'), L, y - 48, 10, B, muted);
    T(t('CUSTOMERS IN VIETNAM (VND)', 'KHÁCH TẠI VIỆT NAM (VND)'), L, y - 66, 10, B, accent);
    T(`${t('Bank', 'Ngân hàng')}: ${vn.bank}   ${t('Account', 'Số TK')}: ${vn.account}   ${t('Holder', 'Chủ TK')}: ${vn.holder}`, L, y - 81, 10, F, ink);
    T(t('INTERNATIONAL (USD)', 'KHÁCH QUỐC TẾ (USD)'), L, y - 103, 10, B, accent);
    T(`${t('Holder', 'Chủ TK')}: ${intl.holder}   ${t('Account', 'Số TK')}: ${intl.account}`, L, y - 118, 10, F, ink);
    T(`ACH: ${intl.ach}   Wire: ${intl.wire}   SWIFT/BIC: ${intl.swift}`, L, y - 132, 10, F, ink);
    T(intl.bankName, L, y - 146, 9, F, muted);

    T(`${t('Transfer reference', 'Nội dung CK')}: ${order.docNo}`, L, y - 172, 10, B, ink);
    T(t('Access is delivered by email once payment is confirmed.', 'Link khóa học sẽ được gửi qua email sau khi xác nhận thanh toán.'), L, y - 190, 10, F, muted);
  }

  // Footer
  page.drawText('Paxneo Tech  -  ' + DOC_EMAILS.join('  -  ') + '  -  paxneo.net', { x: L, y: 50, size: 9, font: F, color: muted });

  const bytes = await doc.save();
  return Buffer.from(bytes).toString('base64');
}

// ---- Student Training Agreement PDF (English, 1 page) — D2C proof-of-service contract.
export async function buildAgreementPdf({ student, courseName, fee, duration = TRAINING_DURATION, date }) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([595, 842]);
  const F = await doc.embedFont(FONT_REGULAR, { subset: true });
  const B = await doc.embedFont(FONT_BOLD, { subset: true });
  const ink = rgb(0.09, 0.11, 0.18), muted = rgb(0.5, 0.5, 0.58), accent = rgb(0.42, 0.36, 1);
  const L = 45, R = 550, W = R - L;
  const T = (s, x, y, sz, f = F, c = ink) => page.drawText(String(s || ''), { x, y, size: sz, font: f, color: c });
  const line = (y, x1 = L, x2 = R, col = rgb(0.85, 0.85, 0.9)) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 1, color: col });
  // Word-wrapped paragraph; returns the y position after the last line.
  const para = (s, x, y, sz, f = F, c = ink, maxW = W, lh = 15) => {
    let cur = '';
    for (const w of String(s || '').split(' ')) {
      const test = cur ? cur + ' ' + w : w;
      if (f.widthOfTextAtSize(test, sz) > maxW && cur) { T(cur, x, y, sz, f, c); y -= lh; cur = w; } else cur = test;
    }
    if (cur) { T(cur, x, y, sz, f, c); y -= lh; }
    return y;
  };

  // Header
  const brand = 'PAXNEO';
  T(brand, L, 800, 20, B, ink);
  T('TECH', L + B.widthOfTextAtSize(brand, 20), 800, 20, B, accent);
  T(DOC_EMAILS.join('   '), L, 784, 9, F, muted);
  T('STUDENT TRAINING AGREEMENT', L, 752, 18, B, ink);
  T('Date: ' + date, L, 736, 10, F, muted);
  line(726);

  let y = 706;
  T('PROVIDER', L, y, 10, B, accent); y -= 16;
  T(PROVIDER.legalName + '  (' + PROVIDER.tradeName + ')', L, y, 11, B, ink); y -= 15;
  y = para(PROVIDER.address, L, y, 11, F, ink);
  T('Email: ' + DOC_EMAILS.join(' / '), L, y, 11, F, ink); y -= 24;

  T('STUDENT', L, y, 10, B, accent); y -= 16;
  T(student.name, L, y, 11, B, ink); y -= 15;
  T('Email: ' + student.email, L, y, 11, F, ink); y -= 15;
  T('Nationality: ' + (student.nationality || '______________________'), L, y, 11, F, ink); y -= 24;

  T('SCOPE OF SERVICE', L, y, 10, B, accent); y -= 16;
  y = para('Provide online training and resources for the course "' + courseName + '" via paxneo.net.', L, y, 11, F, ink);
  y -= 9;

  T('DURATION & FEE', L, y, 10, B, accent); y -= 16;
  T('Duration: ' + duration, L, y, 11, F, ink); y -= 15;
  T('Training fee: ' + fee + ' (paid in full).', L, y, 11, B, ink); y -= 24;

  T('ACCEPTANCE METHOD', L, y, 10, B, accent); y -= 16;
  y = para("By replying 'I agree to these terms' or 'Confirmed' via email, the Student officially executes and electronically signs this Agreement.", L, y, 11, F, ink);
  y -= 8;
  para('The training fee stated above corresponds to the amount paid by the Student for the service described. This Agreement is effective on the date of the Student’s email acceptance; no handwritten signature is required.', L, y, 10, F, muted);

  // Issuer line (no signature block — acceptance is by email reply).
  T('Issued by ' + PROVIDER.tradeName + ' (' + PROVIDER.legalName + ') on ' + date + '.', L, 120, 10, F, ink);

  T(PROVIDER.tradeName + '  -  ' + DOC_EMAILS.join('  -  ') + '  -  paxneo.net', L, 50, 9, F, muted);

  const bytes = await doc.save();
  return Buffer.from(bytes).toString('base64');
}

// Bank transfer details block (HTML) for the invoice email
export function bankHtml(lang) {
  const vi = lang === 'vi';
  const { vn, intl } = BANK_DETAILS;
  return `<div style="border:1px solid #e3e3ee;border-radius:10px;padding:14px 16px;margin:16px 0;font-size:14px">
    <div style="font-weight:bold;margin-bottom:8px">${vi ? 'Thanh toán bằng chuyển khoản' : 'Pay by bank transfer'}</div>
    <div style="margin-bottom:10px">
      <div style="color:#7c5cff;font-weight:bold;font-size:12px">${vi ? 'KHÁCH TẠI VIỆT NAM (VND)' : 'CUSTOMERS IN VIETNAM (VND)'}</div>
      Bank: ${vn.bank} &nbsp;|&nbsp; ${vi ? 'Số TK' : 'Account'}: ${vn.account} &nbsp;|&nbsp; ${vi ? 'Chủ TK' : 'Holder'}: ${vn.holder}
    </div>
    <div>
      <div style="color:#7c5cff;font-weight:bold;font-size:12px">${vi ? 'KHÁCH QUỐC TẾ (USD)' : 'INTERNATIONAL (USD)'}</div>
      ${vi ? 'Chủ TK' : 'Holder'}: ${intl.holder} &nbsp;|&nbsp; ${vi ? 'Số TK' : 'Account'}: ${intl.account}<br>
      ACH: ${intl.ach} &nbsp;|&nbsp; Wire: ${intl.wire} &nbsp;|&nbsp; SWIFT/BIC: ${intl.swift}<br>
      ${intl.bankName}
    </div>
  </div>`;
}
