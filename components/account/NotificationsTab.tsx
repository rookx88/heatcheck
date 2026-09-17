// Notifications: every switch the account has, in the two channels it reaches you on.
// Email: the settlement result (functions/api/settle.ts) and the weekly newsletter
// (scripts/send-newsletter-issue.ts). In-app: the two cron-written inbox rows
// (functions/api/notify-sweep.ts). Settlement's claimable Ember notification and the
// discovery finds are NOT switchable - they carry Ember, and muting them would hide
// money. Login links and verification codes have no switch either: they are how you
// get in.

import React from 'react';
import { Toggle } from './Toggle';
import type { AccountPrefs, PrefUpdater } from './types';

export const NotificationsTab: React.FC<{ prefs: AccountPrefs; onUpdate: PrefUpdater }> = ({ prefs, onUpdate }) => (
    <section className="hc-acct-panel" aria-labelledby="hc-acct-notifs-h">
        <h2 id="hc-acct-notifs-h">Notifications</h2>
        <p className="hc-acct-lede">Choose what reaches you. Everything saves as you flip it.</p>

        <div className="hc-acct-group">
            <p className="hc-acct-group-title">Email</p>
            <div className="hc-acct-rows">
                <Toggle
                    label="Settlement results"
                    description="An email when a Tank call you made settles - what happened and the Ember it paid."
                    checked={prefs.emailSettlementResults}
                    onChange={(v) => onUpdate('emailSettlementResults', v)}
                />
                <Toggle
                    label="Weekly newsletter"
                    description="The week's recap, a lore spotlight, and an exclusive Tank you can call straight from the email."
                    checked={prefs.newsletterOptIn}
                    onChange={(v) => onUpdate('newsletterOptIn', v)}
                />
            </div>
        </div>

        <div className="hc-acct-group">
            <p className="hc-acct-group-title">In-app inbox</p>
            <div className="hc-acct-rows">
                <Toggle
                    label="Pet hunger reminders"
                    description="Your Captain lets you know when their tummy's rumbling."
                    checked={prefs.notifyPetHungry}
                    onChange={(v) => onUpdate('notifyPetHungry', v)}
                />
                <Toggle
                    label="Daily Tank drop"
                    description="A nudge when fresh Tanks land and your daily picks refresh."
                    checked={prefs.notifyDailyDrop}
                    onChange={(v) => onUpdate('notifyDailyDrop', v)}
                />
            </div>
        </div>

        <p className="hc-acct-note">
            Login links and verification codes always send - they&rsquo;re how you get in. Settlement payouts and
            discovery finds always land in your inbox here too, since they carry Ember.
        </p>
    </section>
);
