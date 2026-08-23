# PhishSim

> A phishing-awareness training tool for running simulated campaigns and measuring how recipients respond.

**[Live demo](https://emailspoof-mlx.vercel.app)**

PhishSim is an educational security-awareness tool for authorized internal training. It lets you build a mock phishing campaign from realistic templates, send it to a list of recipients you control, and track who opens and who clicks — the same mechanics attackers use, surfaced so teams can measure and improve their defenses. It ships with a built-in temp-inbox so you can safely receive and inspect the simulated messages end to end. Intended only for consented awareness training, never for deceiving real targets.

## Features

- Campaign builder with sender identity, subject, and prebuilt HTML templates (password reset, package delivery, IT update, document share)
- Recipient management with per-recipient tracking tokens
- Open tracking via a 1x1 pixel and click tracking via tokenized links
- Per-campaign stats (sent, opened, clicked)
- Disposable temp-inbox to generate addresses and receive test messages
- Supabase-backed persistence with an automatic in-memory fallback

## Stack

- Node.js + Express
- Nodemailer over Brevo SMTP for sending
- Supabase (Postgres) for storage, with in-memory fallback
- Deployed as a Vercel serverless function

## Running locally

```bash
npm install
npm run dev
```

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `.env` for persistence (omit them to use the in-memory store). Sending uses `BREVO_SMTP_USER` and `BREVO_SMTP_KEY`; `BASE_URL` optionally overrides the tracking-link host.

---

Part of a series of 91 small web apps. [Browse them all](https://lorenzoylosada.vercel.app).
