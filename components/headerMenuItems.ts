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
    /** In-page item: 'inbox' opens the notifications modal, 'logout' ends the session. */
    action?: 'inbox' | 'logout';
}

export const HEADER_MENU_ITEMS: readonly HeaderMenuItem[] = [
    { label: 'Home', href: '/' },
    { label: 'My Tanks', href: '/my-tanks/' },
    { label: 'Account', href: '/account/' },
    // Inbox only DISPATCHES the open event - both renderers rely on a
    // NotificationsHost elsewhere on the page to actually render the modal, since it
    // can't render inside the transformed map frame (fixed-overlay containing-block
    // trap).
    { label: 'Inbox', action: 'inbox' },
    { label: 'Log out', action: 'logout' },
];
