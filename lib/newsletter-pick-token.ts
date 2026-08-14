// Just the payload shape signed/verified by lib/pages-functions/tokens.ts's
// signToken/verifyToken for the newsletter-pick flow. Kept as its own zero-dependency
// file (not defined inside functions/api/newsletter/pick.ts) so
// scripts/send-newsletter-issue.ts (a Node script, checked under tsconfig.json) can
// import the type without pulling a Cloudflare Pages Function - and its
// @cloudflare/workers-types-flavored EventContext/Response types - into that program.

export interface NewsletterPickTokenPayload extends Record<string, string | number | boolean> {
    userId: string;
    newsletterIssueId: string;
}
