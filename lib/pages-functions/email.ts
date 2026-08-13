// Verification-code email delivery via Resend's HTTP API (no SDK - a single fetch()
// call is all this needs, and it keeps the Functions bundle small). Requires a
// verified sending domain for heatchecks.io on Resend's side before "from" below
// will actually deliver - see .env.example for setup notes.

import type { Env } from './db';

// Table layout + inline styles throughout (no <style> block, no flexbox/grid) since
// Outlook desktop and a fair chunk of webmail clients strip anything else. Font stack
// mirrors styles/public-site.css so this reads as the same brand as the site.
function verificationEmailHtml(code: string): string {
    const fontStack = "'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif";
    return `
<body style="margin:0;padding:0;background:#000000;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <img src="https://heatchecks.io/images/Heatchecksbanner.svg" width="220" alt="Heatchecks" style="display:block;max-width:220px;width:100%;height:auto;border:0;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="background:#0a0a0a;border:1px solid #262626;border-radius:12px;padding:32px 28px;">
              <img src="https://heatchecks.io/assets/images/mudpuppy-default.png" width="96" alt="Mud Puppy, the Heatchecks pet" style="display:block;margin:0 auto 20px auto;width:96px;height:144px;border:0;" />
              <p style="margin:0 0 20px 0;font-family:${fontStack};font-weight:900;font-size:16px;line-height:1.6;color:rgba(255,255,255,0.85);">
                You're locked in. Confirm this email to keep your spot:
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">
                <tr>
                  <td align="center" style="background:#000000;border:1px solid #ff8c00;border-radius:8px;padding:16px;">
                    <span style="font-family:${fontStack};font-weight:900;font-size:32px;letter-spacing:0.2em;background:linear-gradient(135deg,#f84242,#ff8c00);-webkit-background-clip:text;background-clip:text;color:#ff8c00;">${code}</span>
                  </td>
                </tr>
              </table>
              <p style="margin:0;font-family:${fontStack};font-weight:900;font-size:13px;line-height:1.6;color:rgba(255,255,255,0.5);">
                This code expires in 15 minutes.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="margin:0;font-family:${fontStack};font-weight:900;font-size:11px;letter-spacing:0.05em;color:rgba(255,255,255,0.35);">
                HEATCHECKS.IO
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>`;
}

export async function sendVerificationEmail(env: Env, email: string, code: string): Promise<void> {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured for this Pages Function.');

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: 'Heatchecks <hello@heatchecks.io>',
            to: email,
            subject: 'Confirm your Heatchecks call',
            html: verificationEmailHtml(code),
        }),
    });

    if (!res.ok) {
        throw new Error(`Resend API error: ${res.status} ${await res.text()}`);
    }
}

// Settlement result notification - the "tap the tank, it bursts" payoff moment. Fired
// from functions/api/settle.ts right after settleCall() lands, same fire-and-forget
// pattern as the verification email in functions/api/picks.ts: a Resend failure here
// never fails settlement itself, which has already committed by this point.
function settlementEmailHtml(params: {
    tankQuestion: string;
    result: 'correct' | 'incorrect';
    payoutAmount: number;
    newBalance: number;
}): string {
    const fontStack = "'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif";
    const won = params.result === 'correct';
    const headline = won ? "You called it." : "Not this time.";
    const resultColor = won ? '#2fe6d9' : 'rgba(255,255,255,0.7)';
    return `
<body style="margin:0;padding:0;background:#000000;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <img src="https://heatchecks.io/images/Heatchecksbanner.svg" width="220" alt="Heatchecks" style="display:block;max-width:220px;width:100%;height:auto;border:0;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="background:#0a0a0a;border:1px solid #262626;border-radius:12px;padding:32px 28px;">
              <img src="https://heatchecks.io/assets/images/mudpuppy-default.png" width="96" alt="Mud Puppy, the Heatchecks pet" style="display:block;margin:0 auto 20px auto;width:96px;height:144px;border:0;" />
              <p style="margin:0 0 8px 0;font-family:${fontStack};font-weight:900;font-size:20px;line-height:1.4;color:${resultColor};">
                ${headline}
              </p>
              <p style="margin:0 0 20px 0;font-family:${fontStack};font-weight:700;font-size:14px;line-height:1.6;color:rgba(255,255,255,0.75);">
                ${params.tankQuestion}
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">
                <tr>
                  <td align="center" style="background:#000000;border:1px solid #ff8c00;border-radius:8px;padding:16px;">
                    <span style="font-family:${fontStack};font-weight:900;font-size:32px;letter-spacing:0.05em;background:linear-gradient(135deg,#f84242,#ff8c00);-webkit-background-clip:text;background-clip:text;color:#ff8c00;">+${params.payoutAmount} Ember</span>
                  </td>
                </tr>
              </table>
              <p style="margin:0;font-family:${fontStack};font-weight:900;font-size:13px;line-height:1.6;color:rgba(255,255,255,0.5);">
                New balance: ${params.newBalance} Ember
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="margin:0;font-family:${fontStack};font-weight:900;font-size:11px;letter-spacing:0.05em;color:rgba(255,255,255,0.35);">
                HEATCHECKS.IO
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>`;
}

export async function sendSettlementEmail(
    env: Env,
    email: string,
    params: { tankQuestion: string; result: 'correct' | 'incorrect'; payoutAmount: number; newBalance: number }
): Promise<void> {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured for this Pages Function.');

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: 'Heatchecks <hello@heatchecks.io>',
            to: email,
            subject: params.result === 'correct' ? 'You called it - Ember earned' : 'Your Tank call settled',
            html: settlementEmailHtml(params),
        }),
    });

    if (!res.ok) {
        throw new Error(`Resend API error: ${res.status} ${await res.text()}`);
    }
}

export function generateVerificationCode(): string {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    return String(100000 + (bytes[0] % 900000)); // 6 digits, no leading zero
}
