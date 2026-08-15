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
              <img src="https://heatchecks.io/assets/images/heatchecks-logo.png" width="220" alt="Heatchecks" style="display:block;max-width:220px;width:100%;height:auto;border:0;" />
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
              <a href="https://heatchecks.io/" style="display:inline-block;">
                <img src="https://heatchecks.io/assets/images/heatchecks-logo.png" width="140" alt="Heatchecks" style="display:block;max-width:140px;width:100%;height:auto;border:0;opacity:0.6;" />
              </a>
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
    // Hero image replaces the old small mudpuppy-default.png icon rather than
    // supplementing it - the new art already carries the same mascot + Tank HQ
    // branding, so running both would just be redundant. Built by
    // scripts/optimize-landing-images.ts's buildSettlementEmailImages() job into
    // assets/images/, and must stay listed in scripts/generate-static-site.ts's
    // NEW_SITE_IMAGES or these 404 in production despite existing locally.
    const heroImage = won ? 'tank-email-correct' : 'tank-email-incorrect';
    const heroAlt = won
        ? 'Heatchecks mascot holding a glowing briefcase in front of The Tank HQ'
        : 'Heatchecks mascot setting the briefcase down outside The Tank HQ';
    // This is a retention channel, not just a receipt - explicitly tells the reader
    // they've got another pick available today (once/day during the waitlist phase)
    // and that it pays out either way. "Punishes you for sitting out" is deliberately
    // verbatim from components/AllSetModal.tsx's already-reviewed copy, for voice
    // consistency across touchpoints rather than inventing a new tone here.
    const retentionCopy = won
        ? "That's Ember in the pocket. You've got another call in you today — a new Tank's already up. Win or lose tomorrow, it still pays. Come back and stack it."
        : "Wrong calls still pay — that's the whole point. You've got another pick left today, and a new Tank's already up. This game doesn't punish you for playing. It punishes you for sitting out.";
    // No session/token system exists for a personalized deep link, so this can only
    // land on the homepage - the UTM params are free (Cloudflare Pages serves the
    // same page regardless of query string) and give real visibility into whether
    // this channel is actually driving return visits.
    const ctaUrl = `https://heatchecks.io/?utm_source=email&utm_medium=settlement&utm_content=${won ? 'won' : 'lost'}`;
    return `
<body style="margin:0;padding:0;background:#000000;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <img src="https://heatchecks.io/assets/images/heatchecks-logo.png" width="220" alt="Heatchecks" style="display:block;max-width:220px;width:100%;height:auto;border:0;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="background:#0a0a0a;border:1px solid #262626;border-radius:12px;padding:32px 28px;">
              <img src="https://heatchecks.io/assets/images/${heroImage}.jpg" width="424" alt="${heroAlt}" style="display:block;width:100%;max-width:424px;height:auto;border-radius:8px;margin:0 auto 20px auto;border:0;" />
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
              <p style="margin:20px 0 0 0;font-family:${fontStack};font-weight:700;font-size:13px;line-height:1.6;color:rgba(255,255,255,0.75);">
                ${retentionCopy}
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 0 0;">
                <tr>
                  <td align="center" style="background:#000000;border:1px solid #ff8c00;border-radius:8px;">
                    <a href="${ctaUrl}" style="display:block;padding:14px 24px;font-family:${fontStack};font-weight:900;font-size:14px;letter-spacing:0.03em;color:#ff8c00;text-decoration:none;">
                      Make today's call &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px;">
              <a href="https://heatchecks.io/" style="display:inline-block;">
                <img src="https://heatchecks.io/assets/images/heatchecks-logo.png" width="140" alt="Heatchecks" style="display:block;max-width:140px;width:100%;height:auto;border:0;opacity:0.6;" />
              </a>
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

// Magic-link login email - fired from functions/api/login.ts. Unlike the two senders
// above this one is NOT fire-and-forget at its call site: if the link can't be sent,
// the login request has nothing to show for itself, so the endpoint surfaces a 500
// (same posture as functions/api/resend-verification.ts).
function loginLinkEmailHtml(loginUrl: string): string {
    const fontStack = "'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif";
    return `
<body style="margin:0;padding:0;background:#000000;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <img src="https://heatchecks.io/assets/images/heatchecks-logo.png" width="220" alt="Heatchecks" style="display:block;max-width:220px;width:100%;height:auto;border:0;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="background:#0a0a0a;border:1px solid #262626;border-radius:12px;padding:32px 28px;">
              <img src="https://heatchecks.io/assets/images/mudpuppy-default.png" width="96" alt="Mud Puppy, the Heatchecks pet" style="display:block;margin:0 auto 20px auto;width:96px;height:144px;border:0;" />
              <p style="margin:0 0 20px 0;font-family:${fontStack};font-weight:900;font-size:16px;line-height:1.6;color:rgba(255,255,255,0.85);">
                Tap to jump back into your tank:
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">
                <tr>
                  <td align="center" style="background:#000000;border:1px solid #ff8c00;border-radius:8px;">
                    <a href="${loginUrl}" style="display:block;padding:16px 24px;font-family:${fontStack};font-weight:900;font-size:16px;letter-spacing:0.03em;color:#ff8c00;text-decoration:none;">
                      Log in to Heatchecks &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0;font-family:${fontStack};font-weight:900;font-size:13px;line-height:1.6;color:rgba(255,255,255,0.5);">
                This link works once and expires in 15 minutes. Didn't request it? Just ignore this email &mdash; nothing changes without the click.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px;">
              <a href="https://heatchecks.io/" style="display:inline-block;">
                <img src="https://heatchecks.io/assets/images/heatchecks-logo.png" width="140" alt="Heatchecks" style="display:block;max-width:140px;width:100%;height:auto;border:0;opacity:0.6;" />
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>`;
}

export async function sendLoginLinkEmail(env: Env, email: string, loginUrl: string): Promise<void> {
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
            subject: 'Your Heatchecks login link',
            html: loginLinkEmailHtml(loginUrl),
        }),
    });

    if (!res.ok) {
        throw new Error(`Resend API error: ${res.status} ${await res.text()}`);
    }
}

export function generateVerificationCode(): string {
    // Rejection sampling to avoid the modulo bias a bare `% 900000` over a Uint32 range
    // introduces (it skews ~0.004% toward low codes). Immaterial alone, but this is the
    // brute-force target, so keep the distribution flat.
    const RANGE = 900000;
    const limit = Math.floor(0xffffffff / RANGE) * RANGE; // largest unbiased multiple
    const bytes = new Uint32Array(1);
    do {
        crypto.getRandomValues(bytes);
    } while (bytes[0] >= limit);
    return String(100000 + (bytes[0] % RANGE)); // 6 digits, no leading zero
}
