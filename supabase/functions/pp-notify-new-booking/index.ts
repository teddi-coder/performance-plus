import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ---------------------------------------------------------------------------
// Env vars (set in Supabase dashboard → Edge Functions → Manage secrets)
//   PP_RESEND_API_KEY      Resend email API key
//   PP_WORKSHOP_EMAIL      Workshop notification address
//   PP_ZAPIER_WEBHOOK_URL  Zapier webhook for SMS (optional)
//   PP_WC_API_KEY          WhatConverts API key
//   PP_WC_API_SECRET       WhatConverts API secret
//   PP_WC_PROFILE_ID       WhatConverts profile ID (default: 154641)
// ---------------------------------------------------------------------------

interface BookingRecord {
  id: string;
  created_at: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_year: string | null;
  notes: string | null;
  status: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  gclid: string | null;
  landing_page: string | null;
}

interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  record: BookingRecord;
  schema: string;
  old_record: BookingRecord | null;
}

function formatAustralianPhone(phone: string): string {
  const cleaned = phone.replace(/[\s\-().+]/g, "");
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    return "+61" + cleaned.slice(1);
  }
  if (cleaned.startsWith("61") && cleaned.length === 11) {
    return "+" + cleaned;
  }
  return phone;
}

async function sendEmail(
  resendApiKey: string,
  to: string,
  subject: string,
  text: string
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Performance Plus <onboarding@resend.dev>",
      to: [to],
      subject,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

async function notifyWhatConverts(
  r: BookingRecord,
  apiKey: string,
  apiSecret: string,
  profileId: string
): Promise<void> {
  const credentials = btoa(`${apiKey}:${apiSecret}`);
  const dateCreated = new Date(r.created_at).toISOString().split(".")[0] + "Z";
  const vehicle = [r.vehicle_make, r.vehicle_model, r.vehicle_year].filter(Boolean).join(" ") || "Not provided";

  const landingUrl = new URL("https://services.performanceplus.net.au" + (r.landing_page ?? "/"));
  if (r.utm_source)   landingUrl.searchParams.set("utm_source",   r.utm_source);
  if (r.utm_medium)   landingUrl.searchParams.set("utm_medium",   r.utm_medium);
  if (r.utm_campaign) landingUrl.searchParams.set("utm_campaign", r.utm_campaign);
  if (r.utm_content)  landingUrl.searchParams.set("utm_content",  r.utm_content);
  if (r.utm_term)     landingUrl.searchParams.set("utm_term",     r.utm_term);
  if (r.gclid)        landingUrl.searchParams.set("gclid",        r.gclid);

  const params = new URLSearchParams({
    profile_id:    profileId,
    lead_type:     "web_form",
    lead_status:   "good",
    phone_number:  formatAustralianPhone(r.customer_phone),
    email_address: r.customer_email,
    date_created:  dateCreated,
    landing_url:   landingUrl.toString(),
    ...(r.utm_source   ? { lead_source:   r.utm_source }   : {}),
    ...(r.utm_medium   ? { lead_medium:   r.utm_medium }   : {}),
    ...(r.utm_campaign ? { lead_campaign: r.utm_campaign } : {}),
    ...(r.utm_content  ? { lead_content:  r.utm_content }  : {}),
    ...(r.utm_term     ? { lead_keyword:  r.utm_term }     : {}),
    ...(r.gclid        ? { gclid:         r.gclid }        : {}),
    "additional_fields[Name]":     r.customer_name,
    "additional_fields[Phone]":    r.customer_phone,
    "additional_fields[Email]":    r.customer_email,
    "additional_fields[Vehicle]":  vehicle,
    "additional_fields[Notes]":    r.notes ?? "",
    "additional_fields[utm_source]":   r.utm_source  ?? "",
    "additional_fields[utm_medium]":   r.utm_medium  ?? "",
    "additional_fields[utm_campaign]": r.utm_campaign ?? "",
    "additional_fields[gclid]":        r.gclid ?? "",
  });

  const res = await fetch("https://app.whatconverts.com/api/v1/leads", {
    method: "POST",
    headers: {
      Authorization:  `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WhatConverts API error ${res.status}: ${text}`);
  }
}

async function notifyZapier(r: BookingRecord, webhookUrl: string): Promise<void> {
  const vehicle = [r.vehicle_make, r.vehicle_model, r.vehicle_year].filter(Boolean).join(" ") || "Not provided";

  const params = new URLSearchParams({
    customer_name:  r.customer_name,
    customer_phone: formatAustralianPhone(r.customer_phone),
    customer_email: r.customer_email,
    vehicle,
    notes: r.notes ?? "",
  });

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    throw new Error(`Zapier webhook failed ${res.status}: ${await res.text()}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const RESEND_API_KEY = Deno.env.get("PP_RESEND_API_KEY");
  const WORKSHOP_EMAIL = Deno.env.get("PP_WORKSHOP_EMAIL");
  const ZAPIER_WEBHOOK = Deno.env.get("PP_ZAPIER_WEBHOOK_URL");
  const WC_API_KEY     = Deno.env.get("PP_WC_API_KEY");
  const WC_API_SECRET  = Deno.env.get("PP_WC_API_SECRET");
  const WC_PROFILE_ID  = Deno.env.get("PP_WC_PROFILE_ID") ?? "154641";

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON payload", { status: 400 });
  }

  if (payload.type !== "INSERT") {
    return new Response(
      JSON.stringify({ skipped: true, reason: "Not an INSERT event" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  const r      = payload.record;
  const vehicle = [r.vehicle_make, r.vehicle_model, r.vehicle_year].filter(Boolean).join(" ") || "Not provided";
  const notes  = r.notes?.trim() || "None provided";

  const tasks: Promise<void>[] = [];

  if (RESEND_API_KEY && WORKSHOP_EMAIL) {
    const workshopSubject = `New Booking Request — ${r.customer_name} — Performance Plus`;
    const workshopBody    = `New booking request received.

Customer: ${r.customer_name}
Phone:    ${r.customer_phone}
Email:    ${r.customer_email}

Vehicle: ${vehicle}
Notes:   ${notes}

Source: ${r.utm_source ?? "(direct)"} / ${r.utm_medium ?? ""}
Campaign: ${r.utm_campaign ?? ""}`;

    const customerSubject = `Booking Request Received — Performance Plus`;
    const customerBody    = `Hi ${r.customer_name},

Thanks for your booking request. We've received the following details:

Vehicle: ${vehicle}
Notes:   ${notes}

We'll be in touch within 1 business day to confirm your appointment.

If you need to speak with us sooner, give us a call on 02 6324 1091.

Performance Plus
Queanbeyan, NSW`;

    tasks.push(sendEmail(RESEND_API_KEY, WORKSHOP_EMAIL, workshopSubject, workshopBody));
    tasks.push(sendEmail(RESEND_API_KEY, r.customer_email, customerSubject, customerBody));
  } else {
    console.warn("PP_RESEND_API_KEY or PP_WORKSHOP_EMAIL not set — skipping email");
  }

  if (ZAPIER_WEBHOOK) {
    tasks.push(notifyZapier(r, ZAPIER_WEBHOOK));
  } else {
    console.warn("PP_ZAPIER_WEBHOOK_URL not set — skipping Zapier");
  }

  if (WC_API_KEY && WC_API_SECRET) {
    tasks.push(notifyWhatConverts(r, WC_API_KEY, WC_API_SECRET, WC_PROFILE_ID));
  } else {
    console.warn("PP_WC_API_KEY / PP_WC_API_SECRET not set — skipping WhatConverts");
  }

  const results = await Promise.allSettled(tasks);
  const errors  = results
    .filter((res): res is PromiseRejectedResult => res.status === "rejected")
    .map((res) => String(res.reason));

  if (errors.length > 0) {
    console.error("One or more integrations failed:", errors);
    return new Response(
      JSON.stringify({ partial: true, errors, booking_id: r.id }),
      { status: 207, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, booking_id: r.id }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
