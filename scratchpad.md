# WhatsApp Business Messaging Platform — Technical Reference

Last updated: 2026-10-10

## Overview

- **Name:** `whatsapp` (WhatsApp Business messaging platform)
- **Purpose:** Multi-tenant SaaS for sending WhatsApp template messages via the Meta
  Cloud API. Users verify WhatsApp numbers, manage approved templates, send
  template messages, chat with contacts, and buy message credits via Razorpay.
  Includes an admin/superadmin panel.
- **Status:** Active development.

## Tech stack

| Area        | Choice |
|-------------|--------|
| Framework   | Next.js 14 (App Router) |
| Language    | TypeScript 5 |
| Runtime     | Node.js (Next.js server) |
| Database    | Turso / libSQL (SQLite) via `@libsql/client` + `@prisma/adapter-libsql` |
| ORM         | Prisma 5 (`driverAdapters` preview feature) |
| Auth        | NextAuth v4 (`next-auth`, `@auth/prisma-adapter`), bcryptjs password hashing |
| Payments    | Razorpay |
| UI          | Tailwind CSS, Radix UI primitives, lucide-react icons, class-variance-authority |
| Validation  | zod |
| Messaging   | Meta Graph API (WhatsApp Cloud API) `v19.0` |

## Architecture

- `src/app/` — App Router pages and API route handlers.
- `src/app/api/**/route.ts` — backend REST endpoints (see Backend info).
- `src/lib/db` — Prisma client wired to the Turso libSQL adapter.
- `src/lib/auth` — NextAuth `authOptions` (session, roles).
- `prisma/schema.prisma` — data model (SQLite datasource via `TURSO_DATABASE_URL`).
- Layers: UI pages → API route handlers → Prisma → Turso DB; outbound messaging
  calls the Meta Graph API directly from the route handlers.

## Features

- Email/password auth with roles (`admin`, `superadmin`).
- WhatsApp number registration and verification workflow.
- Template management (create, edit, duplicate, submit for Meta approval, sync).
- Template message sending through the Meta Cloud API.
- Two-way chat (conversations, inbound via webhook, outbound send).
- Credits system (balance, deduction per send, refund on failure).
- Razorpay payments to purchase credit packages.
- Admin panel: user management, package management, stats.
- Audit logging.

## Backend info (API endpoints)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/register` | Register a new user |
| * | `/api/auth/[...nextauth]` | NextAuth handlers (login/session) |
| GET/POST | `/api/numbers` | List / create WhatsApp numbers |
| GET/PATCH/DELETE | `/api/numbers/[id]` | Manage a number |
| POST | `/api/numbers/[id]/verify` | Start verification |
| POST | `/api/numbers/[id]/confirm` | Confirm verification code |
| GET/POST | `/api/templates` | List / create templates |
| GET/PATCH/DELETE | `/api/templates/[id]` | Manage a template |
| POST | `/api/templates/[id]/submit` | Submit template to Meta |
| POST | `/api/templates/[id]/duplicate` | Duplicate a template |
| POST | `/api/templates/sync` | Sync template statuses from Meta |
| GET/POST | `/api/messages` | List / query messages |
| POST | `/api/messages/send` | **Send a template message via Meta** |
| GET | `/api/chat/conversations` | List conversations |
| GET | `/api/chat/[contactPhone]/messages` | Messages for a contact |
| POST | `/api/chat/[contactPhone]/send` | Send a chat message |
| POST | `/api/chat/test-inject` | Test helper: inject an inbound message |
| GET | `/api/credits/balance` | Credit balance |
| POST | `/api/payments/create-order` | Create a Razorpay order |
| POST | `/api/payments/verify` | Verify a Razorpay payment |
| GET/PATCH | `/api/settings/profile` | Profile settings |
| PATCH | `/api/settings/password` | Change password |
| GET | `/api/admin/stats` | Admin dashboard stats |
| GET/POST | `/api/admin/users` + `/[id]` | Admin user management |
| GET/POST | `/api/admin/packages` + `/[id]` | Admin package management |
| GET/POST | `/api/webhooks/whatsapp` | Meta webhook (verify + inbound/status) |

### Message-send flow — `POST /api/messages/send`

1. **Auth:** require a NextAuth session (`session.user.id`), else 401.
2. **Validate body:** require `numberId`, `recipient`, `templateId`; optional
   `variables` (JSON array of strings).
3. **Validate number:** must belong to the user and be `verified`, else 400.
4. **Validate template:** must belong to the user and be `approved`, else 400.
5. **Auth-template OTP guard:** if `template.category === "authentication"` and
   `variables[0]` is missing/empty → return 400
   `{ error: "OTP code variable required for authentication template" }`
   **before** any message record or credit deduction (no dangling row, no credit churn).
6. **Credit check:** superadmins are exempt; others must have `totalCredits > 0`,
   else 400.
7. **Create message** record with `status: "queued"`.
8. **Deduct credit** (`totalCredits -1`, `usedCredits +1`) — skipped for superadmin.
9. **Resolve creds:** `phoneNumberId` from the number record or
   `META_PHONE_NUMBER_ID`; `accessToken` from `META_ACCESS_TOKEN`. If missing →
   mark failed.
10. **Build Meta template components:**
    - `body` component from `variables` (when there are variables).
    - For `authentication` templates, also append a copy-code URL button:
      `{ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: variables[0] }] }`.
11. **POST** to `https://graph.facebook.com/v19.0/{phoneNumberId}/messages`.
12. **Update message** record with `sent`/`failed`, `metaMessageId`, `errorMessage`.
13. **On failure:** refund the credit (non-superadmin) and return 500.
14. **On success:** return 200 `{ id, status: "sent" }`.

## Schema (Prisma / `prisma/schema.prisma`)

| Model | Key fields | Relationships |
|-------|-----------|---------------|
| `User` | email (unique), passwordHash, role (`admin`/`superadmin`), isActive | has many numbers, templates, messages, payments, conversations, auditLogs; one credits |
| `UserCredits` | userId (unique), totalCredits, usedCredits | belongs to User |
| `WhatsAppNumber` | phoneNumber (unique), wabaId, phoneNumberId, verificationStatus | belongs to User; has templates, messages, conversations |
| `Template` | name, **category** (marketing/utility/authentication), language, body, header/footer/buttons, status, metaTemplateId | belongs to User + optional WhatsAppNumber; has messages |
| `Message` | recipientPhone, templateVariables (JSON), status, direction, metaMessageId, errorMessage | belongs to User, WhatsAppNumber, optional Template + Conversation |
| `Conversation` | contactPhone, unreadCount, lastMessageAt (unique: numberId+contactPhone) | belongs to User + WhatsAppNumber; has messages |
| `Payment` | razorpayOrderId (unique), amount, creditsPurchased, status | belongs to User |
| `AuditLog` | action, entityType, entityId, old/newValues | optional User |
| `Package` | planId (unique), name, credits, price fields, isActive/isPopular | — |

- Datasource: SQLite provider pointed at Turso (`env("TURSO_DATABASE_URL")`),
  accessed through the libSQL driver adapter.

## Configuration / environment (key names only — no values)

| Key | Meaning |
|-----|---------|
| `TURSO_DATABASE_URL` | Turso/libSQL database URL (Prisma datasource) |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `META_ACCESS_TOKEN` | Meta Graph API access token for sending messages |
| `META_PHONE_NUMBER_ID` | Default WhatsApp phone number ID |
| `META_WABA_ID` | WhatsApp Business Account ID |
| `META_APP_ID` | Meta app ID |
| `META_APP_SECRET` | Meta app secret |
| `META_WEBHOOK_VERIFY_TOKEN` | Verify token for the Meta webhook |
| `NEXTAUTH_URL` | NextAuth base URL |
| `NEXTAUTH_SECRET` | NextAuth session secret |
| `NEXTAUTH_JWT_SECRET` | NextAuth JWT secret |
| `RAZORPAY_KEY_ID` | Razorpay public key ID |
| `RAZORPAY_KEY_SECRET` | Razorpay secret key |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay webhook signing secret |

## Build / test / scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local dev server |
| `npm run build` | `prisma generate && next build` (regression gate) |
| `npm run start` | Production server |
| `npm run lint` | ESLint (next lint) |
| `npm run db:generate` | `prisma generate` |
| `npm run db:push` | `prisma db push` |
| `npm run db:studio` | Prisma Studio |
| `npx tsc --noEmit` | Type-check only (lighter than full build) |

## Security highlights

- Session-gated API routes via NextAuth; `superadmin` role bypasses credit limits.
- Passwords hashed with bcryptjs.
- Resource ownership enforced in queries (number/template scoped to `userId`).
- Secrets provided via env vars (never committed).

## Known context / gotchas

- `templateVariables` and template `buttons`/`mediaAttachments` are stored as JSON
  strings in SQLite.
- Authentication templates with a copy-code URL button require a matching
  `button` component carrying the OTP, or Meta returns `(#131008) Required
  parameter is missing`. The send route handles this (see message-send flow).
- Credit deduction and refund-on-failure must stay consistent — guard early
  returns before `message.create`/deduction to avoid dangling rows.

## Change log

### 2026-10-10
- Fixed `(#131008) Required parameter is missing` on authentication-template
  sends in `POST /api/messages/send`. Added the copy-code URL `button` component
  (`sub_type: "url"`, `index: "0"`, OTP = `variables[0]`) alongside the existing
  `body` component for templates where `category === "authentication"`. Added an
  early 400 guard (`OTP code variable required for authentication template`) that
  returns before any message record or credit deduction when the OTP variable is
  missing, preserving credit consistency. No schema change.
