// POST /api/enroll — create order, store it, email invoice PDF to customer + notify admin.
import { COURSE, priceOf, sendEmail, saveOrder, buildPdf, buildAgreementPdf, bankHtml, AGREEMENT_FILENAME, CUSTOMER_CC } from '../lib/core.js';

const esc = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  if (!b || typeof b !== 'object') b = {};

  const name = (b.name || '').toString().trim();
  const email = (b.email || '').toString().trim();
  const courseId = (b.courseId || '').toString().trim();
  const lang = b.lang === 'vi' ? 'vi' : 'en';

  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid name or email' });
  }
  const c = COURSE[courseId];
  if (!c) return res.status(400).json({ error: 'Unknown course' });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'Email not configured' });

  const price = priceOf(courseId, lang);
  const now = new Date();
  const id = 'PX' + now.getTime().toString(36) + Math.random().toString(36).slice(2, 6);
  const ymd = now.toISOString().slice(0, 10);
  const order = {
    id, invoiceNo: 'INV-' + ymd.replace(/-/g, '') + '-' + id.slice(-4).toUpperCase(),
    date: ymd, name, email, courseId, courseName: c.name, lang,
    amountDisplay: price.display, amountValue: price.value, currency: price.currency,
    status: 'pending', createdAt: now.toISOString(),
  };

  let stored = true;
  try { await saveOrder(order); } catch (e) { stored = false; }

  const pdf = await buildPdf({ kind: 'INVOICE', order: { ...order, docNo: order.invoiceNo } });
  // Student Training Agreement (D2C proof-of-service); nationality left blank for the student to fill.
  const agreement = await buildAgreementPdf({
    student: { name, email, nationality: '' }, courseName: c.name, fee: price.display, date: ymd,
  });

  const vi = lang === 'vi';
  const custHtml = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222">
    <p>${vi ? 'Chào' : 'Hi'} ${esc(name)},</p>
    <p>${vi ? `Cảm ơn bạn đã đăng ký <b>${esc(c.name)}</b>. Đính kèm là hóa đơn (${order.invoiceNo}).`
            : `Thanks for enrolling in <b>${esc(c.name)}</b>. Your invoice (${order.invoiceNo}) is attached.`}</p>
    <p>${vi ? 'Số tiền' : 'Amount'}: <b>${order.amountDisplay}</b></p>
    ${bankHtml(lang)}
    <p>${vi ? 'Đính kèm còn có Hợp đồng đào tạo (Student Training Agreement). Không cần ký tay — chỉ cần phản hồi email này với nội dung "Tôi đồng ý với các điều khoản này" (hoặc "I agree to these terms") để chấp thuận.'
            : 'Also attached is your Student Training Agreement. No handwritten signature is needed — simply reply to this email with "I agree to these terms" or "Confirmed" to accept.'}</p>
    <p>${vi ? 'Sau khi chúng tôi xác nhận thanh toán, bạn sẽ nhận email kèm biên nhận và link truy cập khóa học.'
            : 'Once we confirm your payment, you will receive a receipt and your course access link by email.'}</p>
    <p>${vi ? 'Đội ngũ Paxneo' : 'The Paxneo team'}</p></div>`;

  const cust = await sendEmail({
    from: 'Paxneo <support@paxneo.net>', to: [email], cc: CUSTOMER_CC, reply_to: 'support@paxneo.net',
    subject: vi ? `Hóa đơn đăng ký: ${c.name}` : `Your invoice: ${c.name}`,
    html: custHtml,
    attachments: [
      { filename: order.invoiceNo + '.pdf', content: pdf },
      { filename: AGREEMENT_FILENAME, content: agreement },
    ],
  });

  await sendEmail({
    from: 'Paxneo Orders <onboarding@resend.dev>', to: ['support@paxneo.net'], reply_to: email,
    subject: `New order ${order.invoiceNo}: ${c.name} — ${name}`,
    html: `<h2>New enrollment</h2><p><b>${esc(name)}</b> (${esc(email)})<br>Course: ${esc(c.name)}<br>
      Amount: ${order.amountDisplay}<br>Order id: ${order.id}<br>Stored: ${stored}</p>
      <p>Confirm payment in the <a href="https://paxneo.net/admin.html">admin panel</a>.</p>`,
  });

  return res.status(200).json({ ok: true, customerEmailed: cust.ok, stored });
}
