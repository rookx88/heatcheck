import { renderHead, topbar, footer } from './waitlist-landing-template';

/**
 * The account page - where a logged-in user sees and manages everything account-level:
 * a standing strip (Ember, lifetime earned, Hall of Fame rank, record, member since)
 * over four tabs - Profile / Notifications / Connections / Security. Generic static
 * shell; all personalization is fetched client-side by account-client.tsx from GET
 * /api/account, so this page is safely CDN-cacheable. noindex: an account page has no
 * business in search results.
 *
 * Styles live here (page chrome), not in a component CSS file: /assets/account.css is
 * esbuild's side-effect output of the ContentChrome tree the bundle imports, and the
 * page's own look is one <style> block the way login/welcome/my-portfolio do it. The
 * language is the login card's - teal border glow, Baloo headings, gold for the
 * active/"on" state - but on an OPAQUE matte dark-blue panel rather than the login
 * card's glass (see .hc-acct-frame), widened to the portfolio's 860px so the strip and
 * the label + control rows have room.
 */
export function generateAccountPageHtml(baseUrl: string): string {
    const title = 'Account | Heatchecks';
    const description = 'Manage your Heatchecks account - profile, email and in-app notifications, Discord, and sessions.';
    const head = renderHead({ title, description, path: '/account/', baseUrl });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}
    <meta name="robots" content="noindex">
    <link rel="stylesheet" href="/assets/account.css">
    <style>
        /* The shared .hc-page column is sized for prose; the strip + rows want the room
           the portfolio already claims (same override as .hc-portfolio-page). */
        .hc-page.hc-account-page { max-width: 860px; }

        .hc-acct-loading {
            max-width: 560px; margin: 3rem auto; padding: 0 1.5rem; text-align: center;
            font-family: 'Nunito', sans-serif; color: rgba(255,255,255,0.8);
        }

        /* ---- The frame: a MATTE dark-blue panel, teal glow ----
           Opaque on purpose. The login card's translucent glass works for a short
           form, but this page is rows of small text and switches, and the starfield
           (renderHead's body::before) read straight through it. Matte means a flat
           colour - no gradient, no sheen, no backdrop blur - so the panel is a surface
           the content sits ON. The tiles, tab rail and input inside it are darker
           wells cut into that surface. */
        .hc-acct-frame {
            --acct-panel: #0f1a36;   /* the matte dark blue */
            --acct-well: #0a1226;    /* recessed: stat tiles, tab rail, input */
            margin: 2rem auto 2.5rem; padding: 1.5rem 1.5rem 1.75rem;
            background: var(--acct-panel);
            border: 2px solid rgba(47, 230, 217, 0.4);
            border-radius: 20px;
            box-shadow: 0 0 40px rgba(47, 230, 217, 0.12), 0 20px 50px rgba(0, 0, 0, 0.45);
            font-family: 'Nunito', sans-serif; color: rgba(255,255,255,0.88);
        }
        .hc-acct-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin: 0 0 1.1rem; }
        .hc-acct-frame h1 {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; margin: 0;
            font-size: clamp(1.4rem, 6vw, 1.9rem); color: #fff;
            text-shadow: 0 0 18px rgba(47, 230, 217, 0.25);
        }
        .hc-acct-eyebrow {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: var(--hc-teal);
            text-shadow: 0 0 10px rgba(47, 230, 217, 0.45); margin: 0;
        }

        /* ---- Standing strip: five tiles, each a link out ---- */
        .hc-acct-strip {
            display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0.6rem;
            margin: 0 0 1.25rem;
        }
        .hc-acct-stat {
            display: flex; flex-direction: column; gap: 0.2rem; min-width: 0;
            padding: 0.7rem 0.8rem; border-radius: 12px; text-decoration: none;
            background: var(--acct-well); border: 1px solid rgba(255,255,255,0.1);
            transition: border-color 0.15s ease, background 0.15s ease;
        }
        a.hc-acct-stat:hover, a.hc-acct-stat:focus-visible { border-color: rgba(47, 230, 217, 0.55); background: rgba(47, 230, 217, 0.06); outline: none; }
        .hc-acct-stat-label {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.62rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: var(--hc-teal);
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .hc-acct-stat-value {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1.45rem; line-height: 1.1;
            color: var(--hc-gold); font-variant-numeric: tabular-nums;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .hc-acct-stat-value.is-muted { color: rgba(255,255,255,0.55); font-size: 1.1rem; }
        .hc-acct-stat-sub { font-size: 0.72rem; color: rgba(255,255,255,0.5); }
        .hc-acct-strip--single { grid-template-columns: 1fr; }

        /* ---- Tabs: one row of segments, the active one lit gold ---- */
        .hc-acct-tabs {
            display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; overflow: hidden;
            background: var(--acct-well); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px;
            margin: 0 0 1.25rem;
        }
        .hc-acct-tab {
            appearance: none; border: 0; margin: 0; cursor: pointer; background: transparent;
            padding: 0.7rem 0.4rem 0.62rem;
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: clamp(0.85rem, 3.2vw, 1.05rem);
            letter-spacing: 0.04em; text-transform: uppercase; color: rgba(255,255,255,0.55);
            box-shadow: inset 0 -3px 0 transparent;
            transition: color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
        }
        .hc-acct-tab + .hc-acct-tab { border-left: 1px solid rgba(255,255,255,0.1); }
        .hc-acct-tab:hover:not(.is-active) { color: rgba(255,255,255,0.85); }
        .hc-acct-tab.is-active { color: var(--hc-gold); background: rgba(255, 199, 44, 0.07); box-shadow: inset 0 -3px 0 var(--hc-gold); }
        .hc-acct-tab:focus-visible { outline: 2px solid var(--hc-gold); outline-offset: -4px; border-radius: 8px; }

        /* ---- Panels and rows ---- */
        .hc-acct-panel h2 {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1.1rem; color: #fff;
            margin: 0 0 0.35rem;
        }
        .hc-acct-panel h2 + .hc-acct-lede { margin-top: 0; }
        .hc-acct-lede { font-size: 0.9rem; line-height: 1.5; color: rgba(255,255,255,0.65); margin: 0 0 1rem; }
        .hc-acct-group { margin: 0 0 1.4rem; }
        .hc-acct-group-title {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.68rem;
            letter-spacing: 0.12em; text-transform: uppercase; color: var(--hc-teal); margin: 0 0 0.5rem;
        }
        .hc-acct-rows { display: flex; flex-direction: column; border-top: 1px solid rgba(255,255,255,0.1); }
        .hc-acct-row {
            display: flex; align-items: center; justify-content: space-between; gap: 1rem;
            padding: 0.85rem 0; border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .hc-acct-row-text { min-width: 0; flex: 1 1 auto; }
        .hc-acct-row-label { display: block; font-weight: 800; font-size: 0.98rem; color: #fff; }
        .hc-acct-row-desc { display: block; font-size: 0.84rem; line-height: 1.45; color: rgba(255,255,255,0.6); margin-top: 0.15rem; }
        .hc-acct-row-value { font-size: 0.98rem; color: rgba(255,255,255,0.9); overflow-wrap: anywhere; }
        .hc-acct-row-control { flex: 0 0 auto; display: flex; align-items: center; gap: 0.6rem; }
        .hc-acct-note { font-size: 0.84rem; line-height: 1.5; color: rgba(255,255,255,0.55); margin: 0.75rem 0 0; }

        /* ---- Switch: 44x24 track, gold when on ---- */
        .hc-acct-switch {
            appearance: none; position: relative; width: 44px; height: 24px; flex: 0 0 44px;
            border-radius: 999px; border: 1px solid rgba(255,255,255,0.25); cursor: pointer;
            background: rgba(255,255,255,0.12); padding: 0;
            transition: background 0.18s ease, border-color 0.18s ease;
        }
        .hc-acct-switch::after {
            content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
            background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.4);
            transition: transform 0.18s ease;
        }
        .hc-acct-switch[aria-checked="true"] { background: var(--hc-gold); border-color: var(--hc-gold-dark); }
        .hc-acct-switch[aria-checked="true"]::after { transform: translateX(20px); background: #1a1200; }
        .hc-acct-switch:disabled { opacity: 0.55; cursor: default; }
        .hc-acct-switch:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 2px; }
        .hc-acct-saved { font-size: 0.75rem; color: var(--hc-teal); animation: hc-acct-fade 1.6s ease forwards; }
        @keyframes hc-acct-fade { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }
        .hc-acct-error { font-size: 0.82rem; color: #ff8a80; margin: 0.4rem 0 0; }
        @media (prefers-reduced-motion: reduce) {
            .hc-acct-switch, .hc-acct-switch::after, .hc-acct-tab, .hc-acct-stat { transition: none; }
            .hc-acct-saved { animation: none; }
        }

        /* ---- Badges, buttons, banners ---- */
        .hc-acct-badge {
            display: inline-block; padding: 0.15rem 0.55rem; border-radius: 999px;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.68rem;
            letter-spacing: 0.08em; text-transform: uppercase;
        }
        .hc-acct-badge--ok { background: rgba(47,230,217,0.15); color: var(--hc-teal); }
        .hc-acct-badge--warn { background: rgba(255,199,44,0.15); color: var(--hc-gold); }
        .hc-acct-button {
            display: inline-block; background: var(--hc-gold); color: #1a1200;
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 0.95rem;
            text-decoration: none; padding: 0.55rem 1.3rem; border-radius: 12px; border: none;
            cursor: pointer; white-space: nowrap;
        }
        .hc-acct-button--secondary { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,0.3); }
        .hc-acct-button--danger { background: transparent; color: #ff8a80; border: 1px solid rgba(255,138,128,0.5); }
        .hc-acct-button:disabled { opacity: 0.55; cursor: default; }
        .hc-acct-button:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 2px; }
        .hc-acct-flag { padding: 0.65rem 0.9rem; border-radius: 10px; font-size: 0.9rem; margin: 0 0 1.1rem; }
        .hc-acct-flag--ok { background: rgba(47,230,217,0.15); color: var(--hc-teal); }
        .hc-acct-flag--error { background: rgba(198,40,40,0.15); color: #ff8a80; }

        /* ---- Danger zone ---- */
        .hc-acct-danger {
            margin-top: 1.4rem; padding: 1rem 1.1rem 1.1rem; border-radius: 14px;
            border: 1px solid rgba(255,138,128,0.35); background: rgba(198,40,40,0.06);
        }
        .hc-acct-danger h2 { color: #ff8a80; }
        .hc-acct-danger ul { margin: 0.4rem 0 0.9rem; padding-left: 1.1rem; font-size: 0.86rem; line-height: 1.5; color: rgba(255,255,255,0.7); }
        .hc-acct-confirm { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; }
        .hc-acct-input {
            flex: 1 1 200px; min-width: 0; padding: 0.55rem 0.8rem; border-radius: 10px;
            border: 1px solid rgba(255,255,255,0.25); background: var(--acct-well); color: #fff;
            font-family: 'Nunito', sans-serif; font-size: 0.95rem;
        }
        .hc-acct-input:focus-visible { outline: 2px solid var(--hc-teal); outline-offset: 1px; }

        @media (max-width: 640px) {
            .hc-acct-frame { padding: 1.2rem 1rem 1.4rem; }
            .hc-acct-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .hc-acct-strip--single { grid-template-columns: 1fr; }
            .hc-acct-stat:nth-child(5) { grid-column: 1 / -1; }
            .hc-acct-tab { padding: 0.6rem 0.2rem 0.55rem; letter-spacing: 0.02em; }
            .hc-acct-row { flex-direction: column; align-items: stretch; gap: 0.6rem; }
            .hc-acct-row--inline { flex-direction: row; align-items: center; }
            .hc-acct-row-control { justify-content: flex-start; }
        }
    </style>
</head>
<body>
    <main class="hc-page hc-account-page">
        ${topbar(null)}
        <div id="account-root"></div>
        ${footer()}
    </main>
    <script type="module" src="/assets/account.js" defer></script>
</body>
</html>`;
}
