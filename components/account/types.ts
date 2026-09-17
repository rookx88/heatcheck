// Wire shapes for the account page - the response of GET /api/account
// (functions/api/account.ts) and the partial body of POST /api/account/prefs. Kept as
// one type file so every tab component and the page agree on the same names.

export interface AccountPrefs {
    emailSettlementResults: boolean;
    newsletterOptIn: boolean;
    notifyPetHungry: boolean;
    notifyDailyDrop: boolean;
}
export type PrefKey = keyof AccountPrefs;

export interface AccountStanding {
    balance: number;
    lifetimeEarned: number;
    rank: number | null;
    record: { correct: number; incorrect: number };
}

export interface AccountData {
    userId: string;
    email: string;
    verified: boolean;
    username: string | null;
    onboarded: boolean;
    createdAt: string;
    discord: { linked: boolean; username: string | null };
    prefs: AccountPrefs;
    sessions: { active: number };
    // null for an un-onboarded account (no Ember, no picks yet) - the strip shows a
    // single "finish setting up" tile instead.
    standing: AccountStanding | null;
}

export type TabId = 'profile' | 'notifications' | 'connections' | 'security';
export const TAB_IDS: readonly TabId[] = ['profile', 'notifications', 'connections', 'security'];

// Returns the server's error message on failure (the caller has already reverted the
// optimistic value), null on success.
export type PrefUpdater = (key: PrefKey, value: boolean) => Promise<string | null>;
