# WhatsApp Business API Sender

A multi-tenant WhatsApp Business API platform built with Next.js 14, PostgreSQL, and Prisma. Users can register their Meta-verified WhatsApp numbers, create message templates, and send messages via the WhatsApp Business API.

## Features

- **Multi-tenant Architecture**: Each user manages their own WhatsApp numbers
- **WhatsApp Number Verification**: Register and verify WhatsApp numbers
- **Template Management**: Create templates (marketing, utility, authentication) and submit for Meta approval
- **Message Sending**: Send templated messages to recipients
- **Credit System**: Purchase message credits via Razorpay
- **Dashboard**: Real-time stats and quick actions

## Tech Stack

- **Frontend**: Next.js 14 (App Router), React, Tailwind CSS, shadcn/ui
- **Backend**: Next.js API Routes, Prisma ORM
- **Database**: PostgreSQL
- **Authentication**: NextAuth.js with Credentials provider
- **Payments**: Razorpay integration

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL database
- Meta WhatsApp Business API credentials
- Razorpay account (for payments)

### Installation

1. Clone the repository and navigate to the project:
```bash
cd whatsapp
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` with your credentials:
```env
DATABASE_URL="postgresql://user:password@localhost:5432/whatsapp"
NEXTAUTH_SECRET="your-secret-key"
NEXTAUTH_URL="http://localhost:3000"

# Meta WhatsApp Business API
META_APP_ID=""
META_APP_SECRET=""
META_ACCESS_TOKEN=""
META_WEBHOOK_VERIFY_TOKEN=""

# Razorpay
RAZORPAY_KEY_ID=""
RAZORPAY_KEY_SECRET=""
RAZORPAY_WEBHOOK_SECRET=""
```

4. Set up the database:
```bash
npx prisma db push
npx prisma generate
```

5. Start the development server:
```bash
npm run dev
```

6. Open [http://localhost:3000](http://localhost:3000)

## Project Structure

```
whatsapp/
├── prisma/
│   └── schema.prisma          # Database schema
├── src/
│   ├── app/
│   │   ├── (auth)/            # Auth pages (login, register)
│   │   ├── api/               # API routes
│   │   │   ├── auth/          # Authentication
│   │   │   ├── numbers/       # WhatsApp number management
│   │   │   ├── templates/     # Template management
│   │   │   ├── messages/      # Message sending
│   │   │   ├── payments/      # Razorpay payments
│   │   │   └── credits/       # Credit balance
│   │   ├── dashboard/         # Protected dashboard pages
│   │   ├── login/             # Login page
│   │   └── register/          # Registration page
│   ├── components/
│   │   ├── ui/               # Base UI components
│   │   └── dashboard/        # Dashboard components
│   └── lib/
│       ├── auth.ts            # NextAuth configuration
│       ├── db.ts              # Prisma client
│       └── utils.ts           # Utility functions
├── .env.example
├── package.json
└── README.md
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/[...nextauth]` - NextAuth handlers

### WhatsApp Numbers
- `GET /api/numbers` - List user's numbers
- `POST /api/numbers` - Register a new number
- `GET /api/numbers/[id]` - Get number details
- `DELETE /api/numbers/[id]` - Remove a number
- `POST /api/numbers/[id]/verify` - Initiate verification
- `POST /api/numbers/[id]/confirm` - Confirm verification code

### Templates
- `GET /api/templates` - List user's templates
- `POST /api/templates` - Create a template
- `GET /api/templates/[id]` - Get template details
- `PUT /api/templates/[id]` - Update a template
- `DELETE /api/templates/[id]` - Delete a template
- `POST /api/templates/[id]/submit` - Submit for Meta approval

### Messages
- `GET /api/messages` - List sent messages
- `POST /api/messages/send` - Send a message

### Payments
- `POST /api/payments/create-order` - Create Razorpay order
- `POST /api/payments/verify` - Verify payment

### Credits
- `GET /api/credits/balance` - Get user's credit balance

## Workflow

1. **Register** → Create an account
2. **Add Number** → Register your Meta-verified WhatsApp number
3. **Verify** → Complete OTP verification
4. **Create Template** → Design a message template
5. **Submit** → Submit template for Meta approval
6. **Wait** → Meta reviews (24-48 hours)
7. **Send** → Use approved templates to send messages
8. **Buy Credits** → Purchase credits via Razorpay

## Database Schema

### Users
- `id`, `email`, `passwordHash`, `fullName`, `companyName`
- `createdAt`, `updatedAt`, `lastLoginAt`, `isActive`, `emailVerified`

### WhatsApp Numbers
- `id`, `userId`, `phoneNumber`, `wabaId`, `phoneNumberId`
- `verificationStatus` (pending → in_progress → verified/failed)
- `verifiedAt`

### Templates
- `id`, `userId`, `whatsappNumberId`, `name`, `category`
- `body`, `headerType`, `headerContent`, `footerContent`, `buttons`
- `status` (draft → submitted → approved/rejected)
- `rejectionReason`, `metaTemplateId`

### Messages
- `id`, `userId`, `whatsappNumberId`, `templateId`
- `recipientPhone`, `templateVariables`, `status`
- `metaMessageId`, `sentAt`, `deliveredAt`, `readAt`

### Payments
- `id`, `userId`, `razorpayPaymentId`, `razorpayOrderId`
- `amount`, `creditsPurchased`, `creditsUsed`, `status`

### User Credits
- `userId`, `totalCredits`, `usedCredits`, `lastRechargedAt`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `NEXTAUTH_SECRET` | Secret for NextAuth.js |
| `NEXTAUTH_URL` | Application URL |
| `META_APP_ID` | Meta App ID |
| `META_APP_SECRET` | Meta App Secret |
| `META_ACCESS_TOKEN` | Meta Access Token |
| `META_WEBHOOK_VERIFY_TOKEN` | Token for webhook verification |
| `RAZORPAY_KEY_ID` | Razorpay Key ID |
| `RAZORPAY_KEY_SECRET` | Razorpay Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay Webhook Secret |

## Available Scripts

```bash
npm run dev      # Start development server
npm run build    # Build for production
npm run start    # Start production server
npm run lint     # Run ESLint
npm run db:generate  # Generate Prisma client
npm run db:push     # Push schema to database
npm run db:studio   # Open Prisma Studio
```

## Production Deployment

1. Set up PostgreSQL database
2. Configure all environment variables
3. Run `npm run build`
4. Run `npm run db:push`
5. Start with `npm run start`

## License

MIT
