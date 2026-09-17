// The one definition of the logged-in mini-nav's contents, shared by the two places
// that render it: MapHud (JSX - map pages and, via ContentChrome, scrolling content
// pages) and homepage-client's mountHeaderMenu (vanilla DOM hung off the SSR'd
// .hc-auth chip). They were two independently hardcoded lists until they drifted -
// "Account" was added to MapHud's and silently missed on the homepage's - so the list
// lives here and both renderers map over it instead.

export interface HeaderMenuItem {
    label: string;
    /** Plain navigation item. Exactly one of href/action is set. */
    href?: string;
    /**
     * In-page item: 'inbox' opens the notifications modal, 'playbook' opens My Playbook,
     * 'logout' ends the session. Both renderers branch on the value EXPLICITLY - a new
     * action must be handled in MapHud.tsx and homepage-client.tsx mountHeaderMenu, or
     * it renders as a dead button (it used to fall through to log out).
     */
    action?: 'inbox' | 'playbook' | 'logout';
}

export const HEADER_MENU_ITEMS: readonly HeaderMenuItem[] = [
    { label: 'Home', href: '/' },
    // Tank picks AND TANKDAQ index holdings, in two tabs. Was "My Tanks" at /my-tanks/,
    // which 301s here (scripts/generate-redirects.ts).
    { label: 'My Portfolio', href: '/my-portfolio/' },
    // The characters' errands (Plays), current and completed. Dispatch-only, like Inbox:
    // a PlaybookHost elsewhere on the page renders the modal.
    { label: 'My Playbook', action: 'playbook' },
    { label: 'Account', href: '/account/' },
    // Inbox only DISPATCHES the open event - both renderers rely on a
    // NotificationsHost elsewhere on the page to actually render the modal, since it
    // can't render inside the transformed map frame (fixed-overlay containing-block
    // trap).
    { label: 'Inbox', action: 'inbox' },
    { label: 'Log out', action: 'logout' },
];
