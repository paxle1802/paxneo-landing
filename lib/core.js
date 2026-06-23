// Shared core: course data, pricing, KV order store, Resend email, PDF (invoice/receipt).
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Redis } from '@upstash/redis';
import { readFileSync } from 'node:fs';

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

// ---- Resend email (send-only RESEND_API_KEY is fine) ----
export async function sendEmail(payload) {
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
  T('support@paxneo.net', L, 774, 10, F, muted);
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
  page.drawText('Paxneo LLC  -  support@paxneo.net  -  paxneo.net', { x: L, y: 50, size: 9, font: F, color: muted });

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
