const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Database Layer ──
// Uses Supabase when SUPABASE_URL + SUPABASE_ANON_KEY are set, otherwise falls back to in-memory

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

if (supabase) {
  console.log('Using Supabase for persistence');
} else {
  console.log('SUPABASE_URL / SUPABASE_ANON_KEY not set — using in-memory store (data resets on restart)');
}

// In-memory fallback
const mem = {
  campaigns: new Map(),
  recipients: new Map(),
  inbox: new Map(),
  tempAddresses: new Map(),
};

// ── DB helpers ──

const db = {
  // Campaigns
  async createCampaign(campaign) {
    if (supabase) {
      const { error } = await supabase.from('campaigns').insert(campaign);
      if (error) throw error;
    } else {
      mem.campaigns.set(campaign.id, campaign);
    }
  },

  async getCampaign(id) {
    if (supabase) {
      const { data, error } = await supabase.from('campaigns').select('*').eq('id', id).single();
      if (error) return null;
      return data;
    }
    return mem.campaigns.get(id) || null;
  },

  async listCampaigns() {
    if (supabase) {
      const { data, error } = await supabase.from('campaigns').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    }
    return [...mem.campaigns.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },

  async updateCampaign(id, fields) {
    if (supabase) {
      const { error } = await supabase.from('campaigns').update(fields).eq('id', id);
      if (error) throw error;
    } else {
      const c = mem.campaigns.get(id);
      if (c) Object.assign(c, fields);
    }
  },

  async deleteCampaign(id) {
    if (supabase) {
      const { error } = await supabase.from('campaigns').delete().eq('id', id);
      if (error) throw error;
    } else {
      for (const [key, r] of mem.recipients) {
        if (r.campaign_id === id) mem.recipients.delete(key);
      }
      mem.campaigns.delete(id);
    }
  },

  // Recipients
  async createRecipients(rows) {
    if (supabase) {
      const { error } = await supabase.from('recipients').insert(rows);
      if (error) throw error;
    } else {
      for (const r of rows) mem.recipients.set(r.id, r);
    }
  },

  async getRecipientsByCampaign(campaignId, unsentOnly = false) {
    if (supabase) {
      let q = supabase.from('recipients').select('*').eq('campaign_id', campaignId);
      if (unsentOnly) q = q.is('sent_at', null);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    }
    let list = [...mem.recipients.values()].filter(r => r.campaign_id === campaignId);
    if (unsentOnly) list = list.filter(r => !r.sent_at);
    return list;
  },

  async updateRecipient(id, fields) {
    if (supabase) {
      const { error } = await supabase.from('recipients').update(fields).eq('id', id);
      if (error) throw error;
    } else {
      const r = mem.recipients.get(id);
      if (r) Object.assign(r, fields);
    }
  },

  async getRecipientByToken(token) {
    if (supabase) {
      const { data, error } = await supabase.from('recipients').select('*').eq('token', token).single();
      if (error) return null;
      return data;
    }
    for (const r of mem.recipients.values()) {
      if (r.token === token) return r;
    }
    return null;
  },

  // Temp Addresses
  async createTempAddress(email, label) {
    if (supabase) {
      const { error } = await supabase.from('temp_addresses').upsert({ email, label, created_at: new Date().toISOString() });
      if (error) throw error;
    } else {
      mem.tempAddresses.set(email, { created_at: new Date().toISOString(), label: label || '' });
    }
  },

  async listTempAddresses() {
    if (supabase) {
      const { data: addrs } = await supabase.from('temp_addresses').select('*').order('created_at', { ascending: false });
      const results = [];
      for (const a of addrs || []) {
        const { count } = await supabase.from('inbox').select('*', { count: 'exact', head: true }).eq('to', a.email);
        results.push({ ...a, message_count: count || 0 });
      }
      return results;
    }
    const addresses = [];
    for (const [email, meta] of mem.tempAddresses) {
      const count = [...mem.inbox.values()].filter(m => m.to === email).length;
      addresses.push({ email, ...meta, message_count: count });
    }
    return addresses;
  },

  async deleteTempAddress(email) {
    if (supabase) {
      await supabase.from('inbox').delete().eq('to', email);
      await supabase.from('temp_addresses').delete().eq('email', email);
    } else {
      mem.tempAddresses.delete(email);
      for (const [id, msg] of mem.inbox) {
        if (msg.to === email) mem.inbox.delete(id);
      }
    }
  },

  // Inbox
  async createInboxMessage(msg) {
    if (supabase) {
      const { error } = await supabase.from('inbox').insert(msg);
      if (error) throw error;
    } else {
      mem.inbox.set(msg.id, msg);
    }
  },

  async listInbox(toFilter) {
    if (supabase) {
      let q = supabase.from('inbox').select('id, to, from, subject, received_at').order('received_at', { ascending: false });
      if (toFilter) q = q.eq('to', toFilter);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    }
    let messages = [...mem.inbox.values()];
    if (toFilter) messages = messages.filter(m => m.to === toFilter);
    messages.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
    return messages.map(({ id, to, from, subject, received_at }) => ({ id, to, from, subject, received_at }));
  },

  async getInboxMessage(id) {
    if (supabase) {
      const { data, error } = await supabase.from('inbox').select('*').eq('id', id).single();
      if (error) return null;
      return data;
    }
    return mem.inbox.get(id) || null;
  },

  async deleteInboxMessage(id) {
    if (supabase) {
      await supabase.from('inbox').delete().eq('id', id);
    } else {
      mem.inbox.delete(id);
    }
  },

  async clearInbox() {
    if (supabase) {
      await supabase.from('inbox').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    } else {
      mem.inbox.clear();
    }
  },
};

// ── Helpers ──

function resolveBaseUrl() {
  return process.env.BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
}

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

// ── API: Templates ──

app.get('/api/templates', (req, res) => {
  const templates = loadTemplates();
  res.json(Object.keys(templates).map(name => ({ name, preview: templates[name].substring(0, 200) })));
});

app.get('/api/templates/:name', (req, res) => {
  const templates = loadTemplates();
  if (!templates[req.params.name]) return res.status(404).json({ error: 'Template not found' });
  res.json({ name: req.params.name, html: templates[req.params.name] });
});

// ── API: Campaigns ──

app.post('/api/campaigns', async (req, res) => {
  try {
    const { name, from_name, from_email, subject, template, smtp_host, smtp_port, smtp_user, smtp_pass, recipients } = req.body;
    if (!name || !from_name || !from_email || !subject || !template) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const campaignId = uuidv4();
    await db.createCampaign({
      id: campaignId, name, from_name, from_email, subject, template,
      smtp_host: smtp_host || 'internal', smtp_port: smtp_port || 587,
      smtp_user: smtp_user || '', smtp_pass: smtp_pass || '',
      status: 'draft', created_at: new Date().toISOString()
    });

    const recipientList = parseRecipients(recipients || '');
    if (recipientList.length > 0) {
      const rows = recipientList.map(r => ({
        id: uuidv4(), campaign_id: campaignId,
        email: r.email, name: r.name || '',
        token: uuidv4(), sent_at: null, opened_at: null, clicked_at: null
      }));
      await db.createRecipients(rows);
    }

    res.json({ id: campaignId, recipientCount: recipientList.length });
  } catch (err) {
    console.error('Create campaign error:', err);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

app.get('/api/campaigns', async (req, res) => {
  try {
    const campaigns = await db.listCampaigns();
    const result = [];
    for (const c of campaigns) {
      const recipients = await db.getRecipientsByCampaign(c.id);
      result.push({
        ...c,
        recipient_count: recipients.length,
        sent_count: recipients.filter(r => r.sent_at).length,
        clicked_count: recipients.filter(r => r.clicked_at).length
      });
    }
    res.json(result);
  } catch (err) {
    console.error('List campaigns error:', err);
    res.status(500).json({ error: 'Failed to list campaigns' });
  }
});

app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const campaign = await db.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const recipients = await db.getRecipientsByCampaign(req.params.id);
    res.json({
      ...campaign,
      recipients: recipients.map(({ id, email, name, sent_at, opened_at, clicked_at }) =>
        ({ id, email, name, sent_at, opened_at, clicked_at }))
    });
  } catch (err) {
    console.error('Get campaign error:', err);
    res.status(500).json({ error: 'Failed to get campaign' });
  }
});

app.delete('/api/campaigns/:id', async (req, res) => {
  try {
    await db.deleteCampaign(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete campaign error:', err);
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

// ── API: Launch Campaign ──

app.post('/api/campaigns/:id/launch', async (req, res) => {
  try {
    const campaign = await db.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const recipients = await db.getRecipientsByCampaign(req.params.id, true);
    if (recipients.length === 0) return res.status(400).json({ error: 'No unsent recipients' });

    const useInternalInbox = (campaign.smtp_host || '').toLowerCase() === 'internal';

    let transporter = null;
    if (!useInternalInbox) {
      transporter = nodemailer.createTransport({
        host: campaign.smtp_host,
        port: campaign.smtp_port,
        secure: campaign.smtp_port === 465,
        auth: campaign.smtp_user ? { user: campaign.smtp_user, pass: campaign.smtp_pass } : undefined,
        tls: { rejectUnauthorized: false }
      });
    }

    const templates = loadTemplates();
    const templateHtml = templates[campaign.template] || '<p>Click <a href="{{link}}">here</a> to verify.</p>';
    const baseUrl = resolveBaseUrl();

    await db.updateCampaign(req.params.id, { status: 'sending' });
    res.json({ message: `Sending to ${recipients.length} recipients${useInternalInbox ? ' (temp inbox)' : ''}...` });

    let sentCount = 0;
    for (const recipient of recipients) {
      const trackingLink = `${baseUrl}/track/${recipient.token}`;
      const pixelUrl = `${baseUrl}/pixel/${recipient.token}`;
      const personalizedHtml = templateHtml
        .replace(/\{\{link\}\}/g, trackingLink)
        .replace(/\{\{name\}\}/g, recipient.name || 'there')
        .replace(/\{\{email\}\}/g, recipient.email)
        + `<img src="${pixelUrl}" width="1" height="1" style="display:none" />`;

      try {
        if (useInternalInbox) {
          await db.createInboxMessage({
            id: uuidv4(),
            to: recipient.email,
            from: `"${campaign.from_name}" <${campaign.from_email}>`,
            subject: campaign.subject,
            html: personalizedHtml,
            campaign_id: campaign.id,
            received_at: new Date().toISOString()
          });
          await db.createTempAddress(recipient.email, 'auto');
        } else {
          await transporter.sendMail({
            from: `"${campaign.from_name}" <${campaign.from_email}>`,
            to: recipient.email,
            subject: campaign.subject,
            html: personalizedHtml
          });
        }
        await db.updateRecipient(recipient.id, { sent_at: new Date().toISOString() });
        sentCount++;
      } catch (err) {
        console.error(`Failed to send to ${recipient.email}:`, err.message);
      }

      if (!useInternalInbox) await new Promise(r => setTimeout(r, 100));
    }

    await db.updateCampaign(req.params.id, { status: 'sent' });
    console.log(`Campaign "${campaign.name}": sent ${sentCount}/${recipients.length}`);
  } catch (err) {
    console.error('Launch error:', err);
  }
});

// ── Tracking ──

app.get('/pixel/:token', async (req, res) => {
  const r = await db.getRecipientByToken(req.params.token);
  if (r && !r.opened_at) {
    await db.updateRecipient(r.id, { opened_at: new Date().toISOString() });
  }
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store');
  res.send(gif);
});

app.get('/track/:token', async (req, res) => {
  const r = await db.getRecipientByToken(req.params.token);
  if (r && !r.clicked_at) {
    await db.updateRecipient(r.id, { clicked_at: new Date().toISOString() });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'phished.html'));
});

// ── API: Temp Inbox ──

app.post('/api/inbox/generate', async (req, res) => {
  try {
    const { label } = req.body || {};
    const random = uuidv4().split('-')[0];
    const email = `temp-${random}@phishsim.local`;
    await db.createTempAddress(email, label || '');
    res.json({ email });
  } catch (err) {
    console.error('Generate temp email error:', err);
    res.status(500).json({ error: 'Failed to generate address' });
  }
});

app.get('/api/inbox/addresses', async (req, res) => {
  try {
    res.json(await db.listTempAddresses());
  } catch (err) {
    console.error('List addresses error:', err);
    res.status(500).json({ error: 'Failed to list addresses' });
  }
});

app.get('/api/inbox', async (req, res) => {
  try {
    res.json(await db.listInbox(req.query.to || null));
  } catch (err) {
    console.error('List inbox error:', err);
    res.status(500).json({ error: 'Failed to list inbox' });
  }
});

app.get('/api/inbox/:id', async (req, res) => {
  try {
    const msg = await db.getInboxMessage(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    res.json(msg);
  } catch (err) {
    console.error('Get message error:', err);
    res.status(500).json({ error: 'Failed to get message' });
  }
});

app.delete('/api/inbox/:id', async (req, res) => {
  try {
    await db.deleteInboxMessage(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

app.delete('/api/inbox/address/:email', async (req, res) => {
  try {
    await db.deleteTempAddress(req.params.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete address' });
  }
});

app.delete('/api/inbox', async (req, res) => {
  try {
    await db.clearInbox();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear inbox' });
  }
});

// ── API: Campaign Stats ──

app.get('/api/campaigns/:id/stats', async (req, res) => {
  try {
    const recipients = await db.getRecipientsByCampaign(req.params.id);
    res.json({
      total: recipients.length,
      sent: recipients.filter(r => r.sent_at).length,
      opened: recipients.filter(r => r.opened_at).length,
      clicked: recipients.filter(r => r.clicked_at).length
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ── Local dev server ──

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Phishing Training Tool running at http://localhost:${PORT}`);
  });
}

module.exports = app;
