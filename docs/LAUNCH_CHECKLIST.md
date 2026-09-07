# Public launch checklist

Working order for publishing Game Night commercially. Items marked **owner** are
external accounts/decisions only you can do; everything else is code in this repo.

## 0. Naming & legal (do before any public marketing)

- [ ] **owner** Trademark search for the published brand name in your target
      markets (USPTO [tmsearch.uspto.gov], EUIPO [euipo.europa.eu], plus a plain
      web search). The *name* "Cabo" is used by existing commercial card games;
      game *rules/mechanics* are not protectable, but a published product name
      can infringe a trademark. Pick a distinct brand (keep engine/package ids
      `cabo` internally — no code change needed).
- [ ] **owner** Domain name matching the chosen brand; DNS A/AAAA records to the VPS.
- [ ] Terms of Service page (13+ users, cosmetic purchases are non-refundable
      except where law requires, no gambling/"paid loot" mechanics, acceptable
      use + moderation policy).
- [ ] Privacy Policy page (what is stored: names, avatars, chat, room state in
      Redis; voice/video are peer-to-peer and **never recorded or relayed
      through the server**; analytics is cookieless/self-hosted).
- [ ] **owner** Stripe account (business entity details, bank account); decide
      price points for cosmetic SKUs.
- [ ] **owner** OAuth provider apps if used for accounts (Google / Discord):
      client ids + secrets, redirect URLs.

## 1. Infrastructure

- [x] Optional Caddy TLS proxy in `docker-compose.yaml` (`--profile proxy`):
      automatic HTTPS, required for getUserMedia (mic/cam) and Stripe webhooks.
- [x] Optional self-hosted analytics in `docker-compose.yaml`
      (`--profile analytics`, Umami + Postgres). Cookieless; funnel events are
      emitted by `apps/web/src/analytics.ts`.
- [ ] **owner** VPS provisioned (2 GB RAM is enough), Docker installed, repo
      deployed with `docker compose --profile proxy up -d`, DNS pointed.
- [ ] Verify `https://<domain>/healthz` returns ok and the socket connects.

## 2. Payments (Phase 4)

- [ ] **owner** Stripe webhook endpoint created → `https://<domain>/api/stripe/webhook`,
      secret into `STRIPE_WEBHOOK_SECRET`.
- [ ] Test-mode purchase of every SKU; verify inventory grant + equip.
- [ ] Refund/cancellation procedure documented.

## 3. Moderation & safety

- [ ] Report/block actions reachable in-room; host kick verified.
- [ ] Camera/mic are opt-in per room join; on-air indicator cannot be hidden.
- [ ] Rate limits active on chat, emotes, and media signaling.

## 4. Observability

- [ ] Sentry DSNs (client + server) configured.
- [ ] Analytics funnels verified: home → create → invite accepted → game
      started → voice on → purchase.

## 5. Store/landing assets

- [ ] Logo + favicon set (brand name from step 0).
- [ ] OG/Twitter card images from the 3D table hero.
- [ ] Screenshot set + short demo clip.
