# Moovaz Go — Netlify edition

This package adapts the customer booking site and protected admin dashboard to Netlify. It uses a Netlify Function at `/api/*` and a site-wide Netlify Blobs store for delivery records.

## Routes and booking behavior

- Customer website: `/`
- Operations dashboard: `/admin`
- Booking submission: `POST /api/bookings`
- Public vehicle availability and (if enabled) Bike/Car pricing: `GET /api/config`
- Admin sign-in/session/list: `/api/admin/*`
- Admin delivery update: `PATCH /api/admin/bookings/:reference` (also accepts the record UUID for older dashboard pages)
- Public booking-status lookup: `GET /api/track/:reference`

The customer form clearly states that same-day delivery is unavailable and will only allow dates from tomorrow onward (enforced in both the browser and API). Bike and Car remain visible but disabled with “Unavailable for now”; Van is the only enabled vehicle by default. No numeric upfront Van price is shown or stored—the record only notes that the price is discussed by phone. After submission, clients see that Moovaz Go will call them within 20 minutes to discuss price and confirm delivery details.

Booking records are stored individually in the `moovaz-go-deliveries` Blobs store. The admin dashboard and tracking endpoint use the same records. The owner email notification is sent through Resend if the required email environment variables are configured.

## Redeploy to your existing Netlify site

**Use a Git-connected deployment or the Netlify CLI. A plain static drag-and-drop deploy does not publish the Function.**

1. Extract the ZIP and open the `moovaz-go-netlify` folder.
2. Put the *contents* of that folder at the root of your GitHub repository (`netlify.toml`, `package.json`, `public/`, and `netlify/functions/` should be at the repository root). If you keep the project in a subfolder, set it as Netlify’s base directory.
3. In Netlify, open **Project configuration → Environment variables** and add these for the **Production** context. If Netlify offers scopes, include **Functions**:
   - `ADMIN_PASSWORD` — a private password of at least 12 characters.
   - `ADMIN_SESSION_SECRET` — a random secret of at least 32 characters. Generate a 64-character hex value with:

     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```

   - `MOOVAZ_ENABLED_VEHICLES` — comma-separated IDs from `bike,car,van`. Set it to `van` for the current setup: Bike and Car stay visible as “Unavailable for now,” and the API rejects them. If omitted, the default is also `van`. Add `bike` or `car` here only when you want to make one available again.
   - `MOOVAZ_PRICE_BIKE`, `MOOVAZ_PRICE_CAR` — optional indicative prices as whole NGN numbers, used only if Bike or Car is enabled. There is no `MOOVAZ_PRICE_VAN`; Van pricing is discussed by phone, not shown as a booking estimate.
   - `BOOKING_NOTIFICATION_EMAIL` — the email inbox that should receive new booking alerts.
   - `RESEND_API_KEY` — an API key from your Resend account.
   - `RESEND_FROM_EMAIL` — a sender address on a domain verified with Resend, for example `Moovaz Go <bookings@your-domain.com>`.

4. Push/commit the files to GitHub and let the connected Netlify site build and deploy them. The included `netlify.toml` configures the static publish folder and Functions directory. Environment-variable changes require a new deploy.
5. Open `https://YOUR-SITE.netlify.app/admin` and sign in with `ADMIN_PASSWORD`.
6. If customers should reach the booking site, set the production project visibility to **Public**. The Moovaz Go admin password is separate from any Netlify team-login protection.

If the email settings are missing or Resend rejects a message, the booking is still saved; check the Netlify Function logs for the email warning/error. Verify the sender domain and use an API key with permission to send from it.

For a manual CLI deploy, from this project root run `npm install`, authenticate/link the Netlify CLI to the correct site, then run `npx netlify deploy --build --prod`.

## Local Netlify development

Use Node.js 22.13 or newer. Install dependencies, copy `.env.example` to `.env`, set your secrets and optional vehicle/email settings locally (`.env` is ignored by Git), then run `npx netlify dev`. Netlify Dev uses a local Blobs sandbox; it does not read/write production records.

## Production notes

- Admin sessions use a signed, HttpOnly, eight-hour cookie. Never commit passwords or API keys to GitHub.
- The booking function validates inputs and enforces no same-day delivery. The login throttle is best-effort per warm function instance; consider a managed identity provider/WAF for stricter production controls.
- Bike/Car prices are indicative only if those vehicles are later enabled; Van pricing is agreed by phone. The 20-minute callback is an operational promise that requires staff coverage. This version does not take payment or dispatch couriers automatically. Confirm pricing, coverage, privacy notices, and notification procedures before accepting live deliveries.
