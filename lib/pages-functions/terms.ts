// The version of the Terms of Service / Privacy Policy an account agrees to when it signs
// the welcome letter - stored in waitlist.terms_version by
// functions/api/onboarding/complete.ts. It is the Terms' effective date: bump it in the
// same change that edits scripts/templates/terms-template.ts's EFFECTIVE_DATE (that file
// derives its displayed date from this constant, so the two can't drift).
export const TERMS_VERSION = '2026-09-17';
