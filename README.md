# su-emailspoof - PhishSim Training Tool

Phishing awareness training tool for sending simulated phishing email campaigns and tracking employee responses.

## Features

- Campaign management dashboard with SMTP configuration
- 4 built-in phishing email templates (password reset, document share, IT update, package delivery)
- Mass email sending with rate limiting
- Email open tracking via tracking pixel
- Link click tracking with unique tokens per recipient
- Real-time campaign statistics (sent, opened, clicked)
- "You've Been Phished" training landing page with security tips

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `BASE_URL` | `http://localhost:3000` | Public URL used for tracking links in emails |

## How It Works

1. **Create a campaign** - Configure SMTP, sender info, choose a template, add recipients
2. **Launch** - Emails are sent with unique tracking links per recipient
3. **Track** - Monitor who opened and clicked in real-time
4. **Train** - Employees who click see a training page about spotting phishing

## Templates

Templates are HTML files in the `templates/` directory. Use these placeholders:
- `{{link}}` - Tracking link (required)
- `{{name}}` - Recipient name
- `{{email}}` - Recipient email

## For Authorized Security Training Only

This tool is designed exclusively for internal security awareness training with proper authorization.
