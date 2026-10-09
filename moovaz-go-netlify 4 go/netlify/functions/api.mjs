import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const SESSION_COOKIE = 'moovaz_admin';
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_BODY_BYTES = 24 * 1024;
const STATUSES = ['Pending confirmation', 'Confirmed', 'Out for pickup', 'In transit', 'Delivered', 'Cancelled'];
const WINDOWS = ['08:00–10:00', '10:00–12:00', '12:00–14:00', '14:00–16:00', '16:00–18:00'];
const VEHICLES = {
  bike: { label: 'Bike', defaultPrice: 3500 },
  car: { label: 'Car', defaultPrice: 8000 },
  van: { label: 'Cargo van' }
};

function vehicleConfig() {
  const ids = Object.keys(VEHICLES);
  const rawEnabled = process.env.MOOVAZ_ENABLED_VEHICLES;
  const requested = rawEnabled?.trim()
    ? new Set(rawEnabled.split(',').map((value) => value.trim().toLowerCase()))
    : new Set(['van']);
  const enabledVehicles = ids.filter((id) => requested.has(id));
  const enabled = enabledVehicles.length ? enabledVehicles : ['van'];
  // Bike/car prices can be configured for future availability; no van price is published.
  const prices = Object.fromEntries(['bike', 'car'].map((id) => {
    const raw = process.env[`MOOVAZ_PRICE_${id.toUpperCase()}`]?.trim() || '';
    const parsed = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
    const price = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : VEHICLES[id].defaultPrice;
    return [id, price];
  }));
  return { enabledVehicles: enabled, prices };
}

// The store is site-wide, so requests and status updates survive new deploys.
// Strong consistency keeps the dashboard and public tracking in step after writes.
const store = getStore({ name: 'moovaz-go-deliveries', consistency: 'strong' });
const rateBuckets = new Map();

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin'
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, ...extraHeaders } });
}

function clientKey(request) {
  return request.headers.get('x-nf-client-connection-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
}

function isAllowed(key, limit, intervalMs) {
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || now - current.startedAt >= intervalMs) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}

async function readJson(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    const error = new Error('Request body is too large.');
    error.status = 413;
    throw error;
  }
  try { return text ? JSON.parse(text) : {}; }
  catch {
    const error = new Error('Please send valid JSON.');
    error.status = 400;
    throw error;
  }
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function lagosTomorrow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + 1)).toISOString().slice(0, 10);
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateBooking(body, settings) {
  const booking = {
    pickup: cleanText(body.pickup, 250),
    dropoff: cleanText(body.dropoff, 250),
    date: cleanText(body.date, 10),
    window: cleanText(body.window, 30),
    vehicle: cleanText(body.vehicle, 20),
    name: cleanText(body.name, 120),
    phone: cleanText(body.phone, 40),
    email: cleanText(body.email, 180).toLowerCase(),
    parcel: cleanText(body.parcel, 60),
    notes: cleanText(body.notes, 1500)
  };
  const errors = [];
  if (booking.pickup.length < 4) errors.push('Enter a pickup location.');
  if (booking.dropoff.length < 4) errors.push('Enter a drop-off location.');
  if (booking.pickup.toLowerCase() === booking.dropoff.toLowerCase()) errors.push('Pickup and drop-off must be different.');
  if (!isValidDate(booking.date) || booking.date < lagosTomorrow()) errors.push('We do not offer same-day delivery. Choose a date from tomorrow onward.');
  if (!WINDOWS.includes(booking.window)) errors.push('Choose an available delivery window.');
  if (!Object.hasOwn(VEHICLES, booking.vehicle) || !settings.enabledVehicles.includes(booking.vehicle)) errors.push('That vehicle is currently unavailable. Choose an available option.');
  if (booking.name.length < 2) errors.push('Enter the contact name.');
  const digits = booking.phone.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 16) errors.push('Enter a valid phone number.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(booking.email)) errors.push('Enter a valid email address.');
  if (!booking.parcel) errors.push('Choose what you are sending.');
  return { booking, errors };
}

function publicBooking(booking) {
  return {
    reference: booking.reference,
    pickup: booking.pickup,
    dropoff: booking.dropoff,
    date: booking.date,
    window: booking.window,
    vehicle: booking.vehicle,
    status: booking.status,
    estimate: booking.vehicle === 'van' ? 'Price discussed by phone' : booking.estimate,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt
  };
}

function authConfig() {
  const password = process.env.ADMIN_PASSWORD || '';
  const secret = process.env.ADMIN_SESSION_SECRET || '';
  return password.length >= 12 && secret.length >= 32 ? { password, secret } : null;
}

function constantTimeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function signSession(secret) {
  const payload = Buffer.from(JSON.stringify({ role: 'admin', exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function parseCookie(request, name) {
  const cookieHeader = request.headers.get('cookie') || '';
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

function hasAdminSession(request, secret) {
  const token = parseCookie(request, SESSION_COOKIE);
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  let provided;
  try { provided = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.role === 'admin' && Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch { return false; }
}

function cookieFlags(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

async function listBookings() {
  const bookings = [];
  for await (const page of store.list({ paginate: true, prefix: 'booking/' })) {
    const pageBookings = await Promise.all(page.blobs.map((entry) => store.get(entry.key, { type: 'json' })));
    for (const booking of pageBookings) if (booking) bookings.push(booking);
  }
  return bookings
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((booking) => booking.vehicle === 'van' ? { ...booking, estimate: 'Price discussed by phone' } : booking);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function sendBookingNotification(booking) {
  const apiKey = process.env.RESEND_API_KEY || '';
  const recipient = process.env.BOOKING_NOTIFICATION_EMAIL || '';
  const sender = process.env.RESEND_FROM_EMAIL || '';
  if (!apiKey || !recipient || !sender) {
    console.warn('Booking saved, but email notification is not configured. Set RESEND_API_KEY, BOOKING_NOTIFICATION_EMAIL, and RESEND_FROM_EMAIL.');
    return false;
  }

  const vehicleName = VEHICLES[booking.vehicle]?.label || booking.vehicle;
  const safe = {
    reference: escapeHtml(booking.reference),
    name: escapeHtml(booking.name),
    phone: escapeHtml(booking.phone),
    email: escapeHtml(booking.email),
    pickup: escapeHtml(booking.pickup),
    dropoff: escapeHtml(booking.dropoff),
    date: escapeHtml(booking.date),
    window: escapeHtml(booking.window),
    vehicle: escapeHtml(vehicleName),
    parcel: escapeHtml(booking.parcel),
    estimate: escapeHtml(booking.estimate),
    notes: escapeHtml(booking.notes || 'No handling notes provided.')
  };
  const text = [
    `New Moovaz Go delivery request: ${booking.reference}`,
    `Client: ${booking.name} | ${booking.phone} | ${booking.email}`,
    `Pickup: ${booking.pickup}`,
    `Drop-off: ${booking.dropoff}`,
    `Schedule: ${booking.date}, ${booking.window}`,
    `Vehicle: ${vehicleName} | Price: ${booking.estimate}`,
    `Parcel: ${booking.parcel}`,
    `Handling notes: ${booking.notes || 'None'}`
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;color:#18372b;line-height:1.55;max-width:640px"><p style="color:#4d805b;font-size:11px;font-weight:700;letter-spacing:.12em">NEW MOOVAZ GO REQUEST</p><h1 style="font-size:22px">${safe.reference}</h1><p>A new scheduled delivery was submitted from your website.</p><table style="border-collapse:collapse;width:100%"><tr><td style="padding:7px;border-bottom:1px solid #e5ebe3"><b>Client</b></td><td style="padding:7px;border-bottom:1px solid #e5ebe3">${safe.name}</td></tr><tr><td style="padding:7px;border-bottom:1px solid #e5ebe3"><b>Phone</b></td><td style="padding:7px;border-bottom:1px solid #e5ebe3">${safe.phone}</td></tr><tr><td style="padding:7px;border-bottom:1px solid #e5ebe3"><b>Email</b></td><td style="padding:7px;border-bottom:1px solid #e5ebe3">${safe.email}</td></tr><tr><td style="padding:7px;border-bottom:1px solid #e5ebe3"><b>Pickup</b></td><td style="padding:7px;border-bottom:1px solid #e5ebe3">${safe.pickup}</td></tr><tr><td style="padding:7px;border-bottom:1px solid #e5ebe3"><b>Drop-off</b></td><td style="padding:7px;border-bottom:1px solid #e5ebe3">${safe.dropoff}</td></tr><tr><td style="padding:7px;border-bottom:1px solid #e5ebe3"><b>Schedule</b></td><td style="padding:7px;border-bottom:1px solid #e5ebe3">${safe.date} · ${safe.window}</td></tr><tr><td style="padding:7px;border-bottom:1px solid #e5ebe3"><b>Vehicle / price</b></td><td style="padding:7px;border-bottom:1px solid #e5ebe3">${safe.vehicle} · ${safe.estimate}</td></tr><tr><td style="padding:7px;border-bottom:1px solid #e5ebe3"><b>Parcel</b></td><td style="padding:7px;border-bottom:1px solid #e5ebe3">${safe.parcel}</td></tr><tr><td style="padding:7px;vertical-align:top"><b>Notes</b></td><td style="padding:7px">${safe.notes}</td></tr></table></div>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: sender, to: [recipient], subject: `New delivery request ${booking.reference}`, text, html }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      console.error('Resend email notification failed:', response.status, (await response.text()).slice(0, 500));
      return false;
    }
    return true;
  } catch (error) {
    console.error('Resend email notification error:', error);
    return false;
  }
}

async function createBooking(body) {
  const settings = vehicleConfig();
  const { booking: clean, errors } = validateBooking(body, settings);
  if (errors.length) return json({ error: errors[0], errors }, 400);

  let reference = '';
  let key = '';
  for (let attempt = 0; attempt < 12; attempt += 1) {
    reference = `MVG-${crypto.randomInt(100000, 1000000)}`;
    key = `booking/${reference}`;
    if (!(await store.get(key, { type: 'json' }))) break;
    reference = '';
  }
  if (!reference) return json({ error: 'Could not create a unique booking reference. Please try again.' }, 503);

  const now = new Date().toISOString();
  const booking = {
    id: crypto.randomUUID(), reference, ...clean,
    estimate: clean.vehicle === 'van'
      ? 'Price discussed by phone'
      : `From ₦${new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 }).format(settings.prices[clean.vehicle])}`,
    status: 'Pending confirmation', internalNotes: '', createdAt: now, updatedAt: now
  };
  await store.setJSON(key, booking);
  await sendBookingNotification(booking);
  return json({ booking: publicBooking(booking) }, 201);
}

async function findBookingKey(identifier) {
  if (/^MVG-\d{6}$/i.test(identifier)) return `booking/${identifier.toUpperCase()}`;
  // Accept UUIDs too, for older dashboard pages that sent the record ID.
  for await (const page of store.list({ paginate: true, prefix: 'booking/' })) {
    for (const entry of page.blobs) {
      const booking = await store.get(entry.key, { type: 'json' });
      if (booking?.id === identifier) return entry.key;
    }
  }
  return null;
}

async function updateBooking(identifier, body) {
  const key = await findBookingKey(identifier);
  if (!key) return json({ error: 'Delivery not found.' }, 404);
  const booking = await store.get(key, { type: 'json' });
  if (!booking) return json({ error: 'Delivery not found.' }, 404);
  const status = cleanText(body.status, 40);
  if (!STATUSES.includes(status)) return json({ error: 'Choose a valid delivery status.' }, 400);
  booking.status = status;
  booking.internalNotes = cleanText(body.internalNotes, 1500);
  booking.updatedAt = new Date().toISOString();
  await store.setJSON(key, booking);
  return json({ booking: booking.vehicle === 'van' ? { ...booking, estimate: 'Price discussed by phone' } : booking });
}

async function handle(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  if (method !== 'GET' && !sameOrigin(request)) return json({ error: 'This request is not allowed.' }, 403);

  if (pathname === '/api/health' && method === 'GET') {
    return json({ ok: true, service: 'moovaz-go-netlify' });
  }

  if (pathname === '/api/config' && method === 'GET') {
    return json(vehicleConfig());
  }

  if (pathname === '/api/bookings' && method === 'POST') {
    if (!isAllowed(`booking:${clientKey(request)}`, 12, 60 * 60 * 1000)) {
      return json({ error: 'Too many booking requests. Please try again later.' }, 429);
    }
    try { return await createBooking(await readJson(request)); }
    catch (error) {
      console.error('Moovaz Go booking function error:', error);
      return json({ error: error.status ? error.message : 'We could not save this request. Please try again.' }, error.status || 500);
    }
  }

  const trackingMatch = pathname.match(/^\/api\/track\/(MVG-\d{6})$/i);
  if (trackingMatch && method === 'GET') {
    if (!isAllowed(`track:${clientKey(request)}`, 60, 10 * 60 * 1000)) {
      return json({ error: 'Too many lookups. Please try again shortly.' }, 429);
    }
    try {
      const booking = await store.get(`booking/${trackingMatch[1].toUpperCase()}`, { type: 'json' });
      if (!booking) return json({ error: 'No delivery was found for that reference.' }, 404);
      return json({ booking: publicBooking(booking) });
    } catch (error) {
      console.error('Moovaz Go tracking function error:', error);
      return json({ error: 'Tracking is temporarily unavailable.' }, 500);
    }
  }

  if (pathname === '/api/admin/login' && method === 'POST') {
    const config = authConfig();
    if (!config) return json({ error: 'Admin access is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in Netlify.' }, 503);
    if (!isAllowed(`login:${clientKey(request)}`, 8, 15 * 60 * 1000)) {
      return json({ error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' }, 429);
    }
    try {
      const body = await readJson(request);
      if (!constantTimeEqual(body.password || '', config.password)) return json({ error: 'That password did not match.' }, 401);
      rateBuckets.delete(`login:${clientKey(request)}`);
      const token = signSession(config.secret);
      const cookie = `${SESSION_COOKIE}=${token}; ${cookieFlags(request)}; Max-Age=${SESSION_SECONDS}`;
      return json({ ok: true }, 200, { 'set-cookie': cookie });
    } catch (error) {
      return json({ error: error.status ? error.message : 'Could not sign in. Please try again.' }, error.status || 500);
    }
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    const cookie = `${SESSION_COOKIE}=; ${cookieFlags(request)}; Max-Age=0`;
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }

  if (pathname === '/api/admin/session' && method === 'GET') {
    const config = authConfig();
    if (!config) return json({ error: 'Admin access is not configured.' }, 503);
    return hasAdminSession(request, config.secret)
      ? json({ authenticated: true })
      : json({ authenticated: false }, 401);
  }

  if (pathname === '/api/admin/bookings' && method === 'GET') {
    const config = authConfig();
    if (!config) return json({ error: 'Admin access is not configured.' }, 503);
    if (!hasAdminSession(request, config.secret)) return json({ error: 'Please sign in.' }, 401);
    try { return json({ bookings: await listBookings() }); }
    catch (error) {
      console.error('Moovaz Go admin list error:', error);
      return json({ error: 'Could not load delivery requests.' }, 500);
    }
  }

  const updateMatch = pathname.match(/^\/api\/admin\/bookings\/([A-Za-z0-9-]+)$/);
  if (updateMatch && method === 'PATCH') {
    const config = authConfig();
    if (!config) return json({ error: 'Admin access is not configured.' }, 503);
    if (!hasAdminSession(request, config.secret)) return json({ error: 'Please sign in.' }, 401);
    try { return await updateBooking(updateMatch[1], await readJson(request)); }
    catch (error) {
      console.error('Moovaz Go admin update error:', error);
      return json({ error: error.status ? error.message : 'Could not update this delivery.' }, error.status || 500);
    }
  }

  return json({ error: 'API route not found.' }, 404);
}

export default async (request) => {
  try { return await handle(request); }
  catch (error) {
    console.error('Unexpected Moovaz Go API error:', error);
    return json({ error: 'Unexpected server error.' }, 500);
  }
};

export const config = { path: '/api/*' };
