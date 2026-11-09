# MobieDoor

MobieDoor is a circular electronics platform for device collection, refurbishment, quality verification, and trusted resale.

## Phase 1 setup

The repository is an npm workspace monorepo:

- `apps/frontend` - React, Vite, TypeScript, Tailwind CSS, and React Router
- `apps/backend` - Express, TypeScript, Prisma, and the REST API foundation

## Local development

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `apps/backend/.env` and set `DATABASE_URL` to a MySQL database you control.
3. Install dependencies with `npm install`.
4. Validate the Prisma schema with `npm run db:validate`.
5. Generate the Prisma client with `npm run db:generate`.
6. Create and apply a migration with `npm run db:migrate --workspace @mobiedoor/backend -- --name init`.
7. Start both applications with `npm run dev`.

The frontend runs on `http://localhost:5173` and the API health endpoint is available at `http://localhost:4000/health`.

Development uses convenient localhost defaults for `FRONTEND_URL` and `PORT`. Production does not use localhost fallbacks: `DATABASE_URL`, `FRONTEND_URL`, and `NODE_ENV=production` must be configured, and `FRONTEND_URL` must use HTTPS. The backend validates these settings at startup without logging their values.

## Production configuration

Set environment variables through the hosting provider's secret/configuration manager. Required names are:

- `DATABASE_URL`
- `FRONTEND_URL`
- `NODE_ENV`
- `PORT`

Optional proxy configuration:

- `TRUST_PROXY` - legacy setting retained for compatibility; the backend always trusts exactly one reverse-proxy hop to match the Render deployment topology. Do not change the application to trust proxies broadly when the service is directly reachable.

Provisioning-only names:

- `ADMIN_NAME`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `INITIAL_SETUP_SECRET` - one-time website setup secret, at least 32 characters
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` - required for direct product-image uploads. Store these only in the backend hosting provider's secret manager.

Testing-only name:

- `TEST_DATABASE_URL`

The documented `SESSION_SECRET` variable is reserved for a future signing strategy and is not currently read by the application. Do not treat it as a substitute for the database or hosting-provider secret configuration.

Production sessions use `HttpOnly`, `SameSite=Lax`, and `Secure` cookies. HTTPS is required. State-changing requests must include the configured frontend `Origin`; requests from other origins, or production requests without an origin, are rejected to protect cookie-authenticated operations from CSRF.

The backend handles `SIGTERM` and `SIGINT`, stops accepting new requests, waits up to 10 seconds for active requests, disconnects Prisma, and then completes shutdown. Hosting platforms should send `SIGTERM` during graceful replacement. Rate limits currently use process memory; a shared store is required before running multiple backend instances.

The backend uses Express client-IP resolution for rate limiting and always trusts exactly one proxy hop because Render forwards the client IP through its reverse proxy. Local development continues to work without forwarded headers. Keep the backend inaccessible except through the intended proxy where possible.

## Frontend hosting and SPA routing

The frontend uses `BrowserRouter`. [vercel.json](./vercel.json) rewrites non-API paths to `index.html`, so direct navigation and refreshes for `/admin`, `/products/:slug`, and nested routes work on Vercel. The rewrite intentionally excludes paths beginning with `/api/`; the current architecture uses a separately hosted backend and `VITE_API_URL`, so API traffic is not routed through this frontend deployment.

For another static host, configure its equivalent “all application routes to `index.html`” fallback while leaving API requests routed to the backend. Set the frontend build output to `apps/frontend/dist` and configure `VITE_API_URL` at build time.

## Public API

The backend uses JSON response envelopes. Successful responses return `{ "data": ... }`; paginated product responses also include `meta`. Errors return `{ "error": { "code": "...", "message": "..." } }`.

- `GET /health` - API health check
- `GET /products?search=&category=&sort=featured|price_asc|price_desc|newest&page=1&limit=12` - published product catalogue
- `GET /products/:id` - one published product by ID or slug
- `GET /categories` - categories represented by published products
- `POST /enquiries` - saves contact enquiries
- `POST /trade-in` - saves device collection requests
- `POST /partnerships` - saves business partnership enquiries

Public product and enquiry routes are backed by MySQL through Prisma. Products must be marked `isPublished` before appearing in the public catalogue.

## Admin setup

Phase 4 adds the protected operations workspace:

- `/admin/login` - secure session login
- `/admin` - protected dashboard
- `/admin/products/new` - protected product creation
- `/admin/products/:id/edit` - protected product editing, publishing, and unpublishing

Founder and Admin use the same permission set. Staff can access protected operational reads and enquiry workflows but cannot manage products, inventory, staff accounts, or system-level actions. These permissions are enforced by backend middleware, not only by the UI.

Provision the first admin manually without placing credentials in source control or command history. In PowerShell, set the values only in the current process, run the provisioning command, then clear them:

```powershell
$env:ADMIN_NAME = "Your Name"
$env:ADMIN_EMAIL = "you@example.com"
$env:ADMIN_PASSWORD = "use-a-unique-password-at-least-10-characters"
npm run provision:admin --workspace @mobiedoor/backend
Remove-Item Env:ADMIN_NAME, Env:ADMIN_EMAIL, Env:ADMIN_PASSWORD
```

The provisioning script hashes the password with bcrypt and never stores or prints the plaintext value. Sessions are stored as SHA-256 token hashes in MySQL and delivered through an HTTP-only cookie. Production sessions use `Secure` cookies when `NODE_ENV=production`.

For a local-only Founder account, use the separate create-only command. The script prompts for the name and email, and accepts the password twice interactively without echoing:

```powershell
npm run provision:founder --workspace @mobiedoor/backend
```

The command requires `DATABASE_URL` to target a localhost development database, rejects production and isolated-test database names, refuses an existing email without changing it, and requires typing `CREATE FOUNDER` before inserting a `FOUNDER` user. It uses the existing bcrypt password helper and does not print or store the password in plaintext. Founder and Admin have the same backend management permissions; Staff remains restricted.

The one-time website setup flow is available at `/setup` only while no Founder/Admin
exists and `INITIAL_SETUP_SECRET` is configured. Set this secret through the backend
environment or hosting secret manager; never put it in frontend environment variables
or source control. Apply the `20261107173000_add_initial_setup_state` migration before
using the page. A successful setup creates one Founder account and permanently closes
the setup flow. Existing Founder/Admin accounts are never modified.

Login, public enquiry mutations, and authenticated admin mutations are rate-limited. The backend uses Helmet, a configured CORS origin, explicit origin checks for state-changing requests, request-body limits, Zod validation, and structured authorization errors. Admin mutations require a valid session and role. Expired sessions are cleaned up hourly; cleanup only deletes sessions whose expiry is in the past.

## Admin API

- `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `GET /auth/setup-status`, `POST /auth/setup`
- `GET /admin/dashboard`
- `GET /admin/products`
- `POST /admin/products`, `PATCH /admin/products/:id`, `DELETE /admin/products/:id`
- `PATCH /admin/products/:id/publish`
- `POST /admin/products/:id/inventory`
- `POST /admin/product-images` - Founder/Admin-only multipart upload (`image` field), validated and stored in Cloudinary
- `GET /admin/inventory/history`
- `GET/PATCH /admin/enquiries/:id`
- `GET/PATCH /admin/trade-ins/:id`
- `GET/PATCH /admin/partnerships/:id`
- `GET/POST/PATCH /admin/staff`
- `GET /admin/activity?action=&userId=&from=&to=`
- `GET/POST/PATCH /admin/categories`
- `GET/PUT /admin/settings/:key`

Enquiry list endpoints support `status`, `search`, `page`, and `limit` query parameters and return pagination metadata. Inventory history returns real adjustment records with product, user, quantity, timestamp, and reason.

Important admin actions create activity-log records without passwords, tokens, or secrets.

## Verification

Run the current checks with:

```powershell
npm run db:validate
npm run db:generate
npm run typecheck
npm run build
npm run test --workspace @mobiedoor/backend
```

Backend tests cover public API contracts, validation, database-backed health, unauthenticated access, and Founder/Admin/Staff authorization gates. The admin UI uses controlled form validation and does not display passwords or session tokens. For end-to-end authenticated testing, provision a non-production test account in a separate database and use the login flow; never use production credentials or data.

The endpoint checks should be run with the backend started via `npm run dev --workspace @mobiedoor/backend`. The frontend product catalogue and product details use the live API; contact, trade-in, and partnership forms display success only after the backend returns a `201` response.

## Current limitations

- Authenticated database integration tests are available through `npm run test:integration --workspace @mobiedoor/backend`. They create Founder, Admin, and Staff fixtures, exercise sessions and admin workflows, and clean up only fixture records. The command intentionally skips without `TEST_DATABASE_URL` and refuses URLs whose database name is `mobiedoor`, `prod`, `production`, `live`, or `staging`.
- Analytics are intentionally limited to real aggregate counts and relative bars from dashboard metrics; no time-series reporting exists yet.
- Product categories retain the legacy string field for catalogue compatibility. Managed categories are stored separately and merged into the public category response.
- A Founder/Admin account must be provisioned manually; no default password or seeded account is created.
- Deployment still requires a managed MySQL instance, a production `DATABASE_URL`, a restricted `FRONTEND_URL`, HTTPS, and secure production cookies.
- Product images are uploaded through the authenticated Founder/Admin-only Cloudinary endpoint. The backend accepts only HTTPS URLs hosted by `res.cloudinary.com` when saving products. Existing records containing legacy localhost upload URLs must be re-uploaded from the admin product editor; no database reset or destructive migration is required.
- Production still requires managed database backups, restore testing, structured log collection, uptime monitoring, and a controlled `prisma migrate deploy` release step. Do not use `prisma db push` in production.

Never commit `.env` files or real credentials.

## Isolated integration-test database

Integration tests must use a separate, non-production MySQL database. The test suite does not infer or reuse `apps/backend/.env`; it requires `TEST_DATABASE_URL` and verifies the URL before importing the application or Prisma client. Do not use a development or production customer database.

1. Create an empty MySQL database and test-only database user, for example `mobiedoor_test`. Do not grant the test user access to `mobiedoor`.
2. Copy `apps/backend/.env.test.example` to a local, ignored `.env.test` file and replace the placeholder URL. Never commit that file.
3. In PowerShell, set the URL only for the current process:

```powershell
$env:TEST_DATABASE_URL = "mysql://test_user:test_password@localhost:3306/mobiedoor_test"
$env:DATABASE_URL = $env:TEST_DATABASE_URL
npm run db:deploy --workspace @mobiedoor/backend
npm run test:integration --workspace @mobiedoor/backend
Remove-Item Env:TEST_DATABASE_URL, Env:DATABASE_URL
```

The migration command above targets only the explicitly supplied test database. It must not be run with the development `.env` URL. The integration suite uses unique fixture email/product prefixes, never prints passwords or URLs, and removes only records it created. If the test URL is missing or unsafe, no database operation is attempted and the integration test is reported as skipped.
