// Vercel serverless function: receive enrollment order, email it via Resend.
// Requires env var RESEND_API_KEY. Sends the order to the Paxneo inbox.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse body (Vercel auto-parses JSON; fall back to manual parse just in case)
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  const name = (body.name || '').toString().trim();
  const email = (body.email || '').toString().trim();
  const course = (body.course || '').toString().trim();
  const amount = (body.amount || '').toString().trim();

  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid name or email' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Email service not configured' });
  }

  const esc = (s) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const html = `
    <h2>New course enrollment</h2>
    <table cellpadding="6" style="font-family:Arial,sans-serif;font-size:14px">
      <tr><td><b>Course</b></td><td>${esc(course) || '(not specified)'}</td></tr>
      <tr><td><b>Amount</b></td><td>${esc(amount) || '-'}</td></tr>
      <tr><td><b>Name</b></td><td>${esc(name)}</td></tr>
      <tr><td><b>Email</b></td><td>${esc(email)}</td></tr>
    </table>
    <p style="color:#888;font-size:12px">Sent from paxneo.net enrollment form.</p>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Paxneo Orders <onboarding@resend.dev>',
        to: ['support@paxneo.net'],
        reply_to: email,
        subject: `New enrollment: ${course || 'course'} — ${name}`,
        html,
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: 'Email send failed', detail });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'Email send error', detail: String(err) });
  }
}
