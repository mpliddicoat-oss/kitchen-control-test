# Kitchen Control

UK back-of-house management software for independent restaurants, cafes and food businesses — allergen management, recipe costing, and AI invoice/label scanning, plus menu and dish building. Built by a working head chef in Mevagissey, Cornwall.

**Live at:** https://www.kitchen-control.co.uk
**Pricing:** £12.99/month, 30-day free trial, card required at signup

This is no longer the localStorage-only beta — it's a live production app with real accounts, a database, and paid subscriptions.

## Stack

- **Frontend:** static HTML/CSS/JS (no framework), served by Vercel
- **Backend:** Vercel serverless functions in `api/`
- **Database & Auth:** Supabase (Postgres + Supabase Auth)
- **Billing:** Stripe subscriptions, called directly via the Stripe HTTP API (no Stripe SDK dependency)
- **Email:** SMTP via Nodemailer (account emails, invites, role changes, cancellations)
- **AI scanning:** Google Gemini, called directly via HTTP (invoice scanning, label scanning, recipe import)

Only two npm dependencies: `@supabase/supabase-js` and `nodemailer` (see `package.json`). Everything else (Stripe, Gemini) is plain `fetch` calls.

## What's in this folder

### Marketing / public pages
- **index.html** — homepage
- **for-cafes.html, for-takeaways.html, for-small-kitchens.html, for-outside-catering.html, for-independent-businesses.html** — audience-specific landing pages
- **compare-jelly.html, compare-menuiq.html, compare-spreadsheets.html** — competitor comparison pages
- **guide-allergen-law.html** — UK Food Information Regulations 2014 explainer
- **quick.html, full.html, userguide.html, faq.html** — quick start, full user guide, FAQ
- **demo.html** — live demo with sample data, no signup, nothing saves
- **privacy.html, 404.html** — standard pages
- **llms.txt** — structured summary of the site for LLM crawlers, keep this in sync with the real feature set

### App pages
- **signup.html** — new account signup → Stripe checkout
- **login.html / reset-password.html** — sign in / password reset (Supabase Auth)
- **accept-invite.html** — team member invite acceptance flow
- **unsubscribe.html** — newsletter unsubscribe
- **dashboard.html** — the main app (ingredients, yields, recipes, menus, orders, allergens, invoice/label scanning, recipe import, team management, billing)

### Backend (`api/`)
- **_auth.js** — shared auth helpers: verifies Supabase JWTs, loads caller profile, role/company checks
- **_email.js** — shared Nodemailer transport + HTML email templates
- **_ratelimit.js, _demo.js** — in-memory per-IP rate limiting (general endpoints, and the anonymous demo-scan path)
- **init-user.js** — first-login setup: creates company + profile, links Stripe customer, adds to newsletter
- **create-checkout.js** — starts a Stripe Checkout session (signup mode or logged-in billing mode)
- **create-portal.js** — opens the Stripe customer billing portal
- **cancel-subscription.js** — cancels a subscription, sends confirmation email
- **stripe-webhook.js** — handles Stripe webhook events (signature-verified, 5-minute replay window)
- **invite.js / accept-invite.js** — team invites (owner-only) and acceptance
- **change-role.js / remove-user.js** — owner-only team management
- **scan.js** — ingredient/product label scanning (Gemini) with built-in UK allergen keyword detection
- **recipe-scan.js** — recipe import from photos/PDF/Word/Excel/text (Gemini)
- **invoice.js** — supplier invoice scanning (Gemini)
- **send-email.js** — internal transactional email sending + open-tracking pixel

### Assets & config
- **logo.png / logo2.png, favicons, social-preview images, hero images** — branding/marketing assets
- **manifest.json, sw.js** — PWA manifest and service worker
- **robots.txt, sitemap.xml, BingSiteAuth.xml** — SEO
- **vercel.json** — Vercel config (clean URLs, 30s max duration on API functions)
- **package.json** — dependencies

## Accounts & roles

Real accounts via Supabase Auth (no shared password gate — that beta-era gate has been removed). Each company has:

- **owner** — created at signup, one per company, billing access, can invite/remove/change roles
- **head_chef, sous_chef, chef** — invited by the owner, assigned at invite time (role can be changed later by the owner)

## Environment variables

Set in Vercel project settings, not committed to this folder:

| Variable | Used for |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase client-side auth checks |
| `SUPABASE_SERVICE_KEY` | Supabase server-side (admin) access |
| `STRIPE_SECRET_KEY` | Stripe API calls |
| `STRIPE_PRICE_ID` | the subscription price used at checkout |
| `STRIPE_WEBHOOK_SECRET` | verifying incoming Stripe webhook signatures |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | outgoing email via Nodemailer |
| `GEMINI_API_KEY` | invoice/label scanning and recipe import |

## How to deploy

Matt deploys manually via the Vercel dashboard drag-and-drop (Add New → Project → drag this folder in, or redeploy an existing project by dragging the updated folder onto it). Not connected to GitHub for auto-deploy at the moment.

## Important notes

- This folder (`Development`) is the current working / "last known good" copy. Keep it in sync with whatever actually gets dragged into Vercel.
- The demo (`/demo`) and the demo-mode scanning endpoints are anonymous and IP-rate-limited — no account needed, nothing is saved.
- Rate limiting is in-memory per serverless instance, not distributed — fine for blunting casual abuse, not a hard guarantee under scale.
