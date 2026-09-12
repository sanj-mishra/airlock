import nodemailer, { type Transporter } from "nodemailer";
import type { Verdict } from "@airlock/shared";
import type { EscalationLinks } from "./verdict.js";

let transport: Transporter | null = null;

export function mailerConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS &&
      process.env.ALERT_TO,
  );
}

function getTransport(): Transporter {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT ?? 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transport;
}

function excerpt(content: string, max = 400): string {
  const clean = content.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Sends the Allow/Block mail for an escalation. Never throws — a mail outage
 * must not decide the verdict, and the request is already waiting.
 */
export async function sendEscalation(
  verdict: Verdict,
  links: EscalationLinks,
  payload: string,
): Promise<boolean> {
  if (!mailerConfigured()) {
    console.warn("[mailer] SMTP not configured — skipping escalation mail");
    return false;
  }

  const policy = verdict.signals.egress?.policy ?? "injection_screen";
  const body = excerpt(payload);

  try {
    await getTransport().sendMail({
      from: process.env.ALERT_FROM ?? process.env.SMTP_USER,
      to: process.env.ALERT_TO,
      subject: `[Airlock] Escalation ${links.id} — approval needed`,
      text: `AIRLOCK — human decision required

Reason:  ${verdict.reason}
Policy:  ${policy}
Session: ${verdict.sessionId}

Payload excerpt:
  ${body}

Allow:  ${links.allowUrl}
Block:  ${links.blockUrl}

The agent is holding until you choose. No answer means block.`,
      html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;color:#131a22">
  <p style="font:600 11px/1.4 ui-monospace,monospace;letter-spacing:.12em;color:#a9660b;margin:0 0 6px">
    AIRLOCK · APPROVAL NEEDED</p>
  <h2 style="margin:0 0 14px;font-size:18px;font-weight:600">Escalation <code>${links.id}</code></h2>
  <p style="margin:0 0 6px"><b>Reason:</b> ${escapeHtml(verdict.reason)}</p>
  <p style="margin:0 0 6px"><b>Policy:</b> <code>${escapeHtml(policy)}</code></p>
  <p style="margin:0 0 14px"><b>Session:</b> <code>${escapeHtml(verdict.sessionId)}</code></p>
  <pre style="background:#f2f4f6;padding:12px;border-radius:4px;overflow-x:auto;font-size:12px;white-space:pre-wrap;margin:0 0 20px">${escapeHtml(body)}</pre>
  <p style="margin:0 0 16px">
    <a href="${links.allowUrl}" style="background:#2e7d4f;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:600;display:inline-block">Allow</a>
    &nbsp;&nbsp;
    <a href="${links.blockUrl}" style="background:#be3a2e;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:600;display:inline-block">Block</a>
  </p>
  <p style="color:#77838f;font-size:12px;margin:0">The agent is holding until you choose. No answer means block.</p>
</div>`,
    });
    return true;
  } catch (err) {
    console.error("[mailer] failed to send escalation:", err);
    return false;
  }
}
