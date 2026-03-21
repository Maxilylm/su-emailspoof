const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();

const BASE_URL = process.env.BASE_URL || process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000';

// In-memory store (resets on cold start — use external DB for persistence)
const store = {
  campaigns: new Map(),
  recipients: new Map(),
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Load email templates
function loadTemplates() {
  const templateDir = path.join(__dirname, '..', 'templates');
  const templates = {};
  if (fs.existsSync(templateDir)) {
    for (const file of fs.readdirSync(templateDir)) {
      if (file.endsWith('.html')) {
        const name = path.basename(file, '.html');
        templates[name] = fs.readFileSync(path.join(templateDir, file), 'utf-8');
      }
    }
  }
  return templates;
}

// API: List templates
app.get('/api/templates', (req, res) => {
  const templates = loadTemplates();
  res.json(Object.keys(templates).map(name => ({
    name,
    preview: templates[name].substring(0, 200)
  })));
});

// API: Get template content
app.get('/api/templates/:name', (req, res) => {
  const templates = loadTemplates();
  if (!templates[req.params.name]) return res.status(404).json({ error: 'Template not found' });
  res.json({ name: req.params.name, html: templates[req.params.name] });
});

// API: Create campaign
app.post('/api/campaigns', (req, res) => {
  const { name, from_name, from_email, subject, template, smtp_host, smtp_port, smtp_user, smtp_pass, recipients } = req.body;

  if (!name || !from_name || !from_email || !subject || !template || !smtp_host) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const campaignId = uuidv4();
  const campaign = {
    id: campaignId, name, from_name, from_email, subject, template,
    smtp_host, smtp_port: smtp_port || 587, smtp_user: smtp_user || '', smtp_pass: smtp_pass || '',
    created_at: new Date().toISOString(), status: 'draft'
  };
  store.campaigns.set(campaignId, campaign);

  const recipientList = parseRecipients(recipients || '');
  for (const r of recipientList) {
    const recipientId = uuidv4();
    store.recipients.set(recipientId, {
      id: recipientId, campaign_id: campaignId,
      email: r.email, name: r.name || '',
      token: uuidv4(), sent_at: null, opened_at: null, clicked_at: null
    });
  }

  res.json({ id: campaignId, recipientCount: recipientList.length });
});

// API: List campaigns
app.get('/api/campaigns', (req, res) => {
  const campaigns = [];
  for (const c of store.campaigns.values()) {
    const recipients = [...store.recipients.values()].filter(r => r.campaign_id === c.id);
    campaigns.push({
      ...c,
      recipient_count: recipients.length,
      sent_count: recipients.filter(r => r.sent_at).length,
      clicked_count: recipients.filter(r => r.clicked_at).length
    });
  }
  campaigns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(campaigns);
});

// API: Get campaign details
app.get('/api/campaigns/:id', (req, res) => {
  const campaign = store.campaigns.get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const recipients = [...store.recipients.values()]
    .filter(r => r.campaign_id === req.params.id)
    .map(({ id, email, name, sent_at, opened_at, clicked_at }) => ({ id, email, name, sent_at, opened_at, clicked_at }));

  res.json({ ...campaign, recipients });
});

// API: Delete campaign
app.delete('/api/campaigns/:id', (req, res) => {
  for (const [key, r] of store.recipients) {
    if (r.campaign_id === req.params.id) store.recipients.delete(key);
  }
  store.campaigns.delete(req.params.id);
  res.json({ success: true });
});

// API: Launch campaign (send emails)
app.post('/api/campaigns/:id/launch', async (req, res) => {
  const campaign = store.campaigns.get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const recipients = [...store.recipients.values()]
    .filter(r => r.campaign_id === req.params.id && !r.sent_at);
  if (recipients.length === 0) return res.status(400).json({ error: 'No unsent recipients' });

  const transporter = nodemailer.createTransport({
    host: campaign.smtp_host,
    port: campaign.smtp_port,
    secure: campaign.smtp_port === 465,
    auth: campaign.smtp_user ? { user: campaign.smtp_user, pass: campaign.smtp_pass } : undefined,
    tls: { rejectUnauthorized: false }
  });

  const templates = loadTemplates();
  const templateHtml = templates[campaign.template] || '<p>Click <a href="{{link}}">here</a> to verify.</p>';

  campaign.status = 'sending';
  res.json({ message: `Sending to ${recipients.length} recipients...` });

  let sentCount = 0;
  for (const recipient of recipients) {
    const resolvedBase = process.env.BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
    const trackingLink = `${resolvedBase}/track/${recipient.token}`;
    const pixelUrl = `${resolvedBase}/pixel/${recipient.token}`;
    const personalizedHtml = templateHtml
      .replace(/\{\{link\}\}/g, trackingLink)
      .replace(/\{\{name\}\}/g, recipient.name || 'there')
      .replace(/\{\{email\}\}/g, recipient.email)
      + `<img src="${pixelUrl}" width="1" height="1" style="display:none" />`;

    try {
      await transporter.sendMail({
        from: `"${campaign.from_name}" <${campaign.from_email}>`,
        to: recipient.email,
        subject: campaign.subject,
        html: personalizedHtml
      });
      recipient.sent_at = new Date().toISOString();
      sentCount++;
    } catch (err) {
      console.error(`Failed to send to ${recipient.email}:`, err.message);
    }

    await new Promise(r => setTimeout(r, 100));
  }

  campaign.status = 'sent';
  console.log(`Campaign "${campaign.name}": sent ${sentCount}/${recipients.length}`);
});

// Tracking: open pixel
app.get('/pixel/:token', (req, res) => {
  for (const r of store.recipients.values()) {
    if (r.token === req.params.token && !r.opened_at) {
      r.opened_at = new Date().toISOString();
      break;
    }
  }
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store');
  res.send(gif);
});

// Tracking: link click -> phished page
app.get('/track/:token', (req, res) => {
  for (const r of store.recipients.values()) {
    if (r.token === req.params.token && !r.clicked_at) {
      r.clicked_at = new Date().toISOString();
      break;
    }
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'phished.html'));
});

// API: Campaign stats
app.get('/api/campaigns/:id/stats', (req, res) => {
  const recipients = [...store.recipients.values()].filter(r => r.campaign_id === req.params.id);
  res.json({
    total: recipients.length,
    sent: recipients.filter(r => r.sent_at).length,
    opened: recipients.filter(r => r.opened_at).length,
    clicked: recipients.filter(r => r.clicked_at).length
  });
});

function parseRecipients(input) {
  if (!input) return [];
  return input.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const match = line.match(/^(.+?)\s*<(.+?)>$/);
      if (match) return { name: match[1].trim(), email: match[2].trim() };
      return { name: '', email: line.trim() };
    })
    .filter(r => r.email.includes('@'));
}

// Local dev server
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Phishing Training Tool running at http://localhost:${PORT}`);
  });
}

module.exports = app;
