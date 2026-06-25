import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ---------------------------------------------------------------------------
// Env vars
//   PERFORMANCE_PLUS_RESEND_API_KEY      Resend email API key
//   PERFORMANCE_PLUS_WORKSHOP_EMAIL      Workshop notification address
//   PERFORMANCE_PLUS_ZAPIER_WEBHOOK_URL  Zapier webhook for SMS
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
  registration: string | null;
  preferred_date: string;
  notes: string | null;
  page_source: string | null;
  status: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  gclid: string;
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
  text: string,
  replyTo?: string
): Promise<void> {
  const body: Record<string, unknown> = {
    from: "Performance Plus <bookings@performanceplus.mechanicmarketing.co>",
    to: [to],
    subject,
    text,
  };
  if (replyTo) body.reply_to = replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(`Resend API error ${res.status}: ${responseBody}`);
  }
}

async function notifyZapier(r: BookingRecord, webhookUrl: string): Promise<void> {
  const params = new URLSearchParams({
    customer_name:  r.customer_name,
    customer_phone: formatAustralianPhone(r.customer_phone),
    customer_email: r.customer_email,
    registration:   r.registration ?? "",
    vehicle_make:   r.vehicle_make ?? "",
    vehicle_model:  r.vehicle_model ?? "",
    vehicle_year:   r.vehicle_year ?? "",
    preferred_date: r.preferred_date,
    notes:          r.notes ?? "",
    page_source:    r.page_source ?? "",
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

  const RESEND_API_KEY = Deno.env.get("PERFORMANCE_PLUS_RESEND_API_KEY");
  const WORKSHOP_EMAIL = Deno.env.get("PERFORMANCE_PLUS_WORKSHOP_EMAIL");
  const ZAPIER_WEBHOOK = Deno.env.get("PERFORMANCE_PLUS_ZAPIER_WEBHOOK_URL");

  if (!RESEND_API_KEY) {
    console.error("PERFORMANCE_PLUS_RESEND_API_KEY is not set");
    return new Response("Server configuration error", { status: 500 });
  }
  if (!WORKSHOP_EMAIL) {
    console.error("PERFORMANCE_PLUS_WORKSHOP_EMAIL is not set");
    return new Response("Server configuration error", { status: 500 });
  }

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

  const r     = payload.record;
  const notes = r.notes && r.notes.trim() ? r.notes.trim() : "None provided";
  const page  = r.page_source ?? "unknown";

  const vehicle = [r.vehicle_make, r.vehicle_model, r.vehicle_year]
    .filter(Boolean)
    .join(" ") || "Not provided";

  const workshopSubject = `New Booking Request - ${r.customer_name} (${page})`;
  const workshopBody    = `New booking request received from the ${page} page.

Customer: ${r.customer_name}
Phone:    ${r.customer_phone}
Email:    ${r.customer_email}

Vehicle:        ${vehicle}
Registration:   ${r.registration ?? "Not provided"}
Preferred date: ${r.preferred_date}

Notes: ${notes}

---
UTM source:   ${r.utm_source}
UTM medium:   ${r.utm_medium}
UTM campaign: ${r.utm_campaign}
GCLID:        ${r.gclid}`;

  const customerSubject = `Booking Request Received - Performance Plus Queanbeyan`;
  const customerBody    = `Hi ${r.customer_name},

Thanks for your booking request. We've received the following details:

Vehicle:        ${vehicle}
Registration:   ${r.registration ?? "Not provided"}
Preferred date: ${r.preferred_date}

Notes: ${notes}

We'll be in touch shortly to confirm your booking.

If you need to reach us sooner, call us on 02 6324 1091.

Performance Plus
E/20 Endurance Ave, Queanbeyan NSW 2620
Tuesday - Friday, 7:30 AM - 5:30 PM`;

  const tasks: Promise<void>[] = [
    sendEmail(RESEND_API_KEY, WORKSHOP_EMAIL, workshopSubject, workshopBody, "admin@performanceplus.net.au"),
    sendEmail(RESEND_API_KEY, r.customer_email, customerSubject, customerBody, "admin@performanceplus.net.au"),
  ];

  if (ZAPIER_WEBHOOK) {
    tasks.push(notifyZapier(r, ZAPIER_WEBHOOK));
  } else {
    console.warn("PERFORMANCE_PLUS_ZAPIER_WEBHOOK_URL not set - skipping Zapier");
  }

  const results = await Promise.allSettled(tasks);

  const errors = results
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
