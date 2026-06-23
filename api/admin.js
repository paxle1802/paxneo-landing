// /api/admin — password-protected. GET: list orders. POST {id}: confirm payment -> receipt PDF + course link to customer.
import { listOrders, getOrder, updateOrder, courseLink, sendEmail, buildPdf, buildAgreementPdf, AGREEMENT_FILENAME, CUSTOMER_CC } from '../lib/core.js';

const escH = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function authed(req) {
  const want = process.env.ADMIN_PASSWORD || '';
  const got = req.headers['x-admin-password'] || '';
  return want && got === want;
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'GET') {
    try { return res.status(200).json({ ok: true, orders: await listOrders() }); }
    catch (e) { return res.status(500).json({ error: 'Store unavailable', detail: String(e) }); }
  }

  if (req.method === 'POST') {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const id = (b && b.id || '').toString();
    let order;
    try { order = await getOrder(id); } catch (e) { return res.status(500).json({ error: 'Store unavailable', detail: String(e) }); }
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Send (or resend) the Student Training Agreement — works regardless of payment status.
    if (b && b.action === 'agreement') {
      const agreement = await buildAgreementPdf({
        student: { name: order.name, email: order.email, nationality: (b.nationality || '').toString() },
        courseName: order.courseName, fee: order.amountDisplay, date: order.date,
      });
      const vi = order.lang === 'vi';
      const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222">
        <p>${vi ? 'Chào' : 'Hi'} ${escH(order.name)},</p>
        <p>${vi ? `Đính kèm là Hợp đồng đào tạo cho khóa học <b>${escH(order.courseName)}</b>.`
                : `Attached is your Student Training Agreement for <b>${escH(order.courseName)}</b>.`}</p>
        <p>${vi ? 'Không cần ký tay — chỉ cần phản hồi email này với nội dung "I agree to these terms" (hoặc "Confirmed") để chính thức chấp thuận và ký điện tử hợp đồng.'
                : 'No handwritten signature is needed — simply reply to this email with "I agree to these terms" or "Confirmed" to officially accept and electronically sign this Agreement.'}</p>
        <p>${vi ? 'Đội ngũ Paxneo' : 'The Paxneo team'}</p></div>`;
      const sent = await sendEmail({
        from: 'Paxneo <support@paxneo.net>', to: [order.email], cc: CUSTOMER_CC, reply_to: 'support@paxneo.net',
        subject: 'Paxneo Tech — Student Training Agreement',
        html, attachments: [{ filename: AGREEMENT_FILENAME, content: agreement }],
      });
      if (!sent.ok) return res.status(502).json({ error: 'Agreement email failed', detail: sent.body });
      return res.status(200).json({ ok: true, sentAgreement: true });
    }

    if (order.status === 'paid') return res.status(200).json({ ok: true, already: true });

    const link = courseLink(order.courseId);
    const now = new Date();
    const receiptNo = 'RCP-' + now.toISOString().slice(0, 10).replace(/-/g, '') + '-' + id.slice(-4).toUpperCase();
    const pdf = await buildPdf({ kind: 'RECEIPT', order: { ...order, docNo: receiptNo, link } });

    const vi = order.lang === 'vi';
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222">
      <p>${vi ? 'Chào' : 'Hi'} ${escH(order.name)},</p>
      <p>${vi ? `Chúng tôi đã nhận thanh toán cho <b>${escH(order.courseName)}</b>. Biên nhận (${receiptNo}) đính kèm.`
              : `We've received your payment for <b>${escH(order.courseName)}</b>. Your receipt (${receiptNo}) is attached.`}</p>
      ${link ? `<p><a href="${link}" style="display:inline-block;background:#7c5cff;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">${vi ? 'Mở khóa học' : 'Open the course'}</a></p>
        <p style="font-size:13px;color:#666;word-break:break-all">${link}</p>` : ''}
      <p>${vi ? 'Chúc bạn học vui!' : 'Happy learning!'}</p><p>${vi ? 'Đội ngũ Paxneo' : 'The Paxneo team'}</p></div>`;

    const sent = await sendEmail({
      from: 'Paxneo <support@paxneo.net>', to: [order.email], cc: CUSTOMER_CC, reply_to: 'support@paxneo.net',
      subject: vi ? `Đã nhận thanh toán — Truy cập khóa học: ${order.courseName}` : `Payment received — Course access: ${order.courseName}`,
      html, attachments: [{ filename: receiptNo + '.pdf', content: pdf }],
    });

    const updated = await updateOrder(id, {
      status: sent.ok ? 'paid' : 'pending', receiptNo, paidAt: now.toISOString(), customerEmailed: sent.ok,
    });
    if (!sent.ok) return res.status(502).json({ error: 'Receipt email failed', detail: sent.body });
    return res.status(200).json({ ok: true, order: updated });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
