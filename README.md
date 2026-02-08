# CoverCraft (Netlify + Supabase)

## Local Run

1. Install dependencies:
`npm install`
2. Start local Netlify dev server:
`npx netlify dev`

Do not open `index.html` directly; API routes require Netlify Functions.

## API Routing

`/api/*` is redirected to Netlify Functions via `netlify.toml`:
- `/api/config`
- `/api/profile`
- `/api/ensure-profile`
- `/api/generate`
- `/api/resume-upload`
- `/api/stripe/create-checkout-session`
- `/api/stripe/webhook`

## Required Environment Variables

Supabase:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Stripe:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID`
- `SITE_URL` (or `URL`)

Optional:
- `BACKEND_URL` (defaults to configured Railway backend in functions)
- `STRIPE_PAYMENT_LINK` (if set, checkout endpoint redirects directly to this link)

## Security Notes

- Service role keys must never be exposed client-side.
- SQL policies in `supabase-schema.sql` restrict service-level access with `auth.role() = 'service_role'`.
- `increment_generations` is `SECURITY DEFINER` with `search_path` pinned to `public`.
