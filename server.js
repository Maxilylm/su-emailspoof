const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Database setup
const db = new Database(path.join(dataDir, 'phishing.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    from_name TEXT NOT NULL,
    from_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    template TEXT NOT NULL,
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL DEFAULT 587,
    smtp_user TEXT,
    smtp_pass TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'draft'
  );

  CREATE TABLE IF NOT EXISTS recipients (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    token TEXT UNIQUE NOT NULL,
    sent_at DATETIME,
    opened_at DATETIME,
    clicked_at DATETIME,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );
`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Load email templates
function loadTemplates() {
  const templateDir = path.join(__dirname, 'templates');
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
  db.prepare(`
    INSERT INTO campaigns (id, name, from_name, from_email, subject, template, smtp_host, smtp_port, smtp_user, smtp_pass)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(campaignId, name, from_name, from_email, subject, template, smtp_host, smtp_port || 587, smtp_user || '', smtp_pass || '');

  // Add recipients
  const insertRecipient = db.prepare(`
    INSERT INTO recipients (id, campaign_id, email, name, token)
    VALUES (?, ?, ?, ?, ?)
  `);

  const recipientList = parseRecipients(recipients || '');
  const insertMany = db.transaction((list) => {
    for (const r of list) {
      insertRecipient.run(uuidv4(), campaignId, r.email, r.name || '', uuidv4());
    }
  });
  insertMany(recipientList);

  res.json({ id: campaignId, recipientCount: recipientList.length });
});

// API: List campaigns
app.get('/api/campaigns', (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.*, COUNT(r.id) as recipient_count,
      SUM(CASE WHEN r.sent_at IS NOT NULL THEN 1 ELSE 0 END) as sent_count,
      SUM(CASE WHEN r.clicked_at IS NOT NULL THEN 1 ELSE 0 END) as clicked_count
    FROM campaigns c
    LEFT JOIN recipients r ON r.campaign_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all();
  res.json(campaigns);
});

// API: Get campaign details
app.get('/api/campaigns/:id', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const recipients = db.prepare('SELECT id, email, name, sent_at, opened_at, clicked_at FROM recipients WHERE campaign_id = ?').all(req.params.id);
  res.json({ ...campaign, recipients });
});

// API: Delete campaign
app.delete('/api/campaigns/:id', (req, res) => {
  db.prepare('DELETE FROM recipients WHERE campaign_id = ?').run(req.params.id);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// API: Launch campaign (send emails)
app.post('/api/campaigns/:id/launch', async (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const recipients = db.prepare('SELECT * FROM recipients WHERE campaign_id = ? AND sent_at IS NULL').all(req.params.id);
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

  db.prepare("UPDATE campaigns SET status = 'sending' WHERE id = ?").run(campaign.id);
  res.json({ message: `Sending to ${recipients.length} recipients...` });

  // Send emails in background
  let sentCount = 0;
  for (const recipient of recipients) {
    const trackingLink = `${BASE_URL}/track/${recipient.token}`;
    const pixelUrl = `${BASE_URL}/pixel/${recipient.token}`;
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
      db.prepare('UPDATE recipients SET sent_at = CURRENT_TIMESTAMP WHERE id = ?').run(recipient.id);
      sentCount++;
    } catch (err) {
      console.error(`Failed to send to ${recipient.email}:`, err.message);
    }

    // Rate limit: 100ms between emails
    await new Promise(r => setTimeout(r, 100));
  }

  db.prepare("UPDATE campaigns SET status = 'sent' WHERE id = ?").run(campaign.id);
  console.log(`Campaign "${campaign.name}": sent ${sentCount}/${recipients.length}`);
});

// Tracking: open pixel
app.get('/pixel/:token', (req, res) => {
  db.prepare('UPDATE recipients SET opened_at = CURRENT_TIMESTAMP WHERE token = ? AND opened_at IS NULL').run(req.params.token);
  // 1x1 transparent GIF
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store');
  res.send(gif);
});

// Tracking: link click -> phished page
app.get('/track/:token', (req, res) => {
  const recipient = db.prepare('SELECT r.*, c.name as campaign_name FROM recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE r.token = ?').get(req.params.token);

  if (recipient) {
    db.prepare('UPDATE recipients SET clicked_at = CURRENT_TIMESTAMP WHERE token = ? AND clicked_at IS NULL').run(req.params.token);
  }

  res.sendFile(path.join(__dirname, 'public', 'phished.html'));
});

// API: Campaign stats
app.get('/api/campaigns/:id/stats', (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
      SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) as clicked
    FROM recipients WHERE campaign_id = ?
  `).get(req.params.id);
  res.json(stats);
});

function parseRecipients(input) {
  if (!input) return [];
  return input.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      // Support "Name <email>" or just "email"
      const match = line.match(/^(.+?)\s*<(.+?)>$/);
      if (match) return { name: match[1].trim(), email: match[2].trim() };
      return { name: '', email: line.trim() };
    })
    .filter(r => r.email.includes('@'));
}

app.listen(PORT, () => {
  console.log(`Phishing Training Tool running at ${BASE_URL}`);
  console.log(`Dashboard: ${BASE_URL}`);
});
