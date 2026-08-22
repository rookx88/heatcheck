// Acceptance suite for GET / (functions/index.ts + lib/pages-functions/homepage/*).
// The homepage is the SEO-critical front door: it must fail open (never 500) across
// every session state, gate un-onboarded sessions server-side before any content
// work, and always render a slot for every sport in SPORT_ORDER even when nothing is
// live for it. Because the response is HTML (not JSON), this suite talks to the
// server with raw fetch() against BASE_URL instead of the harness's api() helper -
// api() JSON-parses the body and would just give us `json: null` for every call here.

import { BASE_URL, check, section, type Suite } from '../harness';
import { createUser, mintSessionCookie, cleanupUsersByEmailPrefix } from '../fixtures';
import { SPORT_ORDER } from '../../../sport-map';

const EMAIL_PREFIX = 'acceptance-home-';

async function cleanup() {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
}

async function run() {
    await cleanup();

    // --- Anonymous (the crawler-visible state) ---
    section('Anonymous - 200, real HTML, structural markers present');
    const anonRes = await fetch(`${BASE_URL}/`);
    const anonBody = await anonRes.text();
    check('GET / (no cookie) -> 200', anonRes.status === 200, `got ${anonRes.status}`);
    check('content-type is text/html', (anonRes.headers.get('content-type') ?? '').includes('text/html'),
        anonRes.headers.get('content-type') ?? '(none)');
    check('cache-control is private, no-store (session-dependent HTML)',
        (anonRes.headers.get('cache-control') ?? '').includes('no-store'));
    check('renders the tanks panel heading', anonBody.includes('id="hc-tanks-heading"') && anonBody.includes('Newest Tanks Available'));
    check('renders the sport switcher row', anonBody.includes('class="hc-sport-row"'));
    check('logged-out header shows the login CTA, not an auth chip', anonBody.includes('hc-login-cta') && !anonBody.includes('hc-auth-in'));

    // --- Un-onboarded session ---
    // VERIFIED against functions/index.ts: before any content/DB work, a session
    // whose `onboarded` flag is false gets a hard 302 to /welcome/ with
    // Cache-Control: no-store (and the refreshed Set-Cookie, if any) - this is a real
    // server-side redirect, not a client-side one. The assumed behavior in the plan
    // is correct; asserting it directly here.
    section('Un-onboarded session - 302 redirect to /welcome/, before any content work');
    const unonboarded = await createUser(`${EMAIL_PREFIX}unonboarded@example.com`, { onboarded: false });
    const unonboardedCookie = await mintSessionCookie(unonboarded.userId);
    const gateRes = await fetch(`${BASE_URL}/`, { headers: { Cookie: unonboardedCookie }, redirect: 'manual' });
    check('GET / (un-onboarded cookie) -> 302', gateRes.status === 302, `got ${gateRes.status}`);
    const gateLocation = gateRes.headers.get('location') ?? '';
    check('Location header points at /welcome/', gateLocation.endsWith('/welcome/'), gateLocation);
    check('redirect response sets Cache-Control: no-store', (gateRes.headers.get('cache-control') ?? '').includes('no-store'));

    // --- Onboarded session ---
    section('Onboarded session - 200, reflects username and balance');
    const onboarded = await createUser(`${EMAIL_PREFIX}onboarded@example.com`, { onboarded: true, username: 'acceptancehome' });
    const onboardedCookie = await mintSessionCookie(onboarded.userId);
    const homeRes = await fetch(`${BASE_URL}/`, { headers: { Cookie: onboardedCookie } });
    const homeBody = await homeRes.text();
    check('GET / (onboarded cookie) -> 200', homeRes.status === 200, `got ${homeRes.status}`);
    // 'hc-login-cta' also appears in the page's static <style> block (`.hc-login-cta {
    // ... }`) regardless of login state, so a bare substring-absence check can never
    // pass - assert absence of the actual anchor markup instead.
    check('auth area renders (not the logged-out login CTA)',
        homeBody.includes('data-testid="hc-auth-in"') && !homeBody.includes('class="hc-cta-button hc-login-cta"'));
    check('renders the username', homeBody.includes('>acceptancehome<'));
    // renderHeader() renders the Ember balance inside an aria-label="N Embers" chip
    // and again as the chip's visible text - a brand-new account has balance 0.
    check('renders an Embers balance chip', /aria-label="\d+ Embers"/.test(homeBody));
    // The island hydration payload also carries loggedIn:true for this session -
    // confirms the server, not just the header markup, knows the session is real.
    check('hydration payload marks loggedIn: true', homeBody.includes('"loggedIn":true'));

    // --- Sport coverage: every SPORT_ORDER entry gets a rendered slot ---
    section('Sport coverage - every SPORT_ORDER sport gets a slot (live or placeholder), never a 500');
    check('SPORT_ORDER is non-empty (sanity check on the import itself)', SPORT_ORDER.length > 0, JSON.stringify(SPORT_ORDER));
    for (const sport of SPORT_ORDER) {
        // renderSportRow() emits one <button data-sport="Sport"> per SPORT_ORDER
        // entry regardless of whether it has a live card - live buttons carry
        // data-live, dead ones carry disabled - so data-sport="X" alone proves the
        // slot exists (fail-open: no sport is ever silently dropped from the row).
        check(`sport row includes a slot for ${sport}`, homeBody.includes(`data-sport="${sport}"`));
    }
    // Structural proof (from the current live DB state, not a forced fixture) that a
    // sport with nothing live renders the disabled placeholder button rather than a
    // 500 or a missing slot - if every sport currently has a live Tank this simply
    // finds zero disabled buttons and warns rather than failing, since that's a
    // legitimate (if unlikely) live-data state, not a bug.
    const disabledSportButtons = (homeBody.match(/<button type="button" class="hc-sport-btn" data-sport="[^"]+" disabled/g) ?? []).length;
    if (disabledSportButtons > 0) {
        check('at least one zero-live-tank sport renders its disabled placeholder button', true);
    } else {
        section('(all SPORT_ORDER sports currently have a live Tank in the DB - placeholder-slot markup not exercised this run)');
    }

    // --- Never 500, across every session state exercised above ---
    section('Never 500');
    check('anonymous never 500s', anonRes.status !== 500);
    check('un-onboarded-session redirect never 500s', gateRes.status !== 500);
    check('onboarded session never 500s', homeRes.status !== 500);

    await cleanup();
}

export const suite: Suite = {
    name: 'homepage',
    requiredEnv: ['SESSION_TOKEN_SECRET'],
    run,
};
