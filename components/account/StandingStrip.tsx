// The strip above the tabs: where this account stands, in five tiles that each link
// out to the surface that owns the number. It summarizes, it never manages - Ember
// history is My Portfolio's, the board is the Hall of Fame rotunda on Tank Land
// (/the-tank/; there is no deep-link into the modal, so the tile lands on the map).

import React from 'react';
import type { AccountStanding } from './types';

const fmt = (n: number) => n.toLocaleString('en-US');

function memberSince(createdAt: string): string {
    const d = new Date(createdAt);
    if (Number.isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(d);
}

interface StatProps { href: string; label: string; value: string; sub?: string; muted?: boolean }
const Stat: React.FC<StatProps> = ({ href, label, value, sub, muted }) => (
    <a className="hc-acct-stat" href={href}>
        <span className="hc-acct-stat-label">{label}</span>
        <span className={`hc-acct-stat-value${muted ? ' is-muted' : ''}`}>{value}</span>
        {sub && <span className="hc-acct-stat-sub">{sub}</span>}
    </a>
);

export const StandingStrip: React.FC<{ standing: AccountStanding | null; createdAt: string }> = ({ standing, createdAt }) => {
    if (!standing) {
        return (
            <div className="hc-acct-strip hc-acct-strip--single">
                <Stat href="/welcome/" label="Getting started" value="Finish setting up" sub="Sign the welcome letter to start earning Ember." muted />
            </div>
        );
    }
    const { balance, lifetimeEarned, rank, record } = standing;
    const settled = record.correct + record.incorrect;
    return (
        <div className="hc-acct-strip">
            <Stat href="/my-portfolio/" label="Ember" value={fmt(balance)} sub="balance" />
            <Stat href="/the-tank/" label="Lifetime earned" value={fmt(lifetimeEarned)} sub="game + trading profit" />
            <Stat
                href="/the-tank/"
                label="Hall of Fame"
                value={rank === null ? 'Unranked' : `#${fmt(rank)}`}
                sub={rank === null ? 'earn Ember to rank' : 'by lifetime earned'}
                muted={rank === null}
            />
            <Stat
                href="/my-portfolio/"
                label="Record"
                value={settled === 0 ? '—' : `${record.correct}-${record.incorrect}`}
                sub={settled === 0 ? 'no settled calls yet' : `${settled} settled`}
                muted={settled === 0}
            />
            <Stat href="/my-portfolio/" label="Member since" value={memberSince(createdAt)} />
        </div>
    );
};
