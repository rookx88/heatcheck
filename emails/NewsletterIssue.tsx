// The weekly Heatchecks newsletter template. Rendered via @react-email/render, either
// inside functions/api/newsletter/send-issue.ts (Cloudflare Pages Function) or
// scripts/send-newsletter-issue.ts (Node fallback) - see that file's header comment for
// which one is actually in use, and why.
//
// Three sections, in order of visual weight (heaviest first): Exclusive Tank Prop leads
// because it's the retention lever - the reason to open the email at all - then This
// Week, then Character/Lore Spotlight.
//
// Visual language: stacked comic-panel blocks (bold flat color, thick black rule,
// halftone dot texture) rather than a literal recreation of the original mockup's
// starburst/sunburst illustration - those shapes need real vector art and render
// inconsistently across email clients. Flat color + black border + a bold "shouty"
// display font carries most of the comic-page feel on its own and degrades safely:
// clients that ignore background-image (older Outlook) just show the solid panel
// color, never a broken layout. Display font stack matches the settlement email
// (lib/pages-functions/email.ts's sendSettlementEmail) for a consistent brand voice
// across every Heatchecks email, not just this one.
//
// Logo: assets/images/heatchecks-logo-email.png, a 400x193 PNG rasterized+recompressed
// from the source assets/images/heatchecks-logo.png (43KB vs the source's 253KB - see
// scripts/generate-static-site.ts's NEW_SITE_IMAGES for how it reaches
// /assets/images/ in production). Deliberately NOT public/images/Heatchecksbanner.svg,
// which the settlement email currently uses - that file isn't actually a Heatchecks
// wordmark (it's an unrelated flaming-sports-balls stock image, likely AI-generated -
// its 15MB size comes from an embedded C2PA provenance manifest plus 6 embedded raster
// images inside the "SVG") and SVG has poor/no <img> support in most email clients
// (Outlook desktop doesn't render it at all) regardless. Worth pointing the settlement
// email at this same corrected asset too.

import {
    Body,
    Column,
    Container,
    Head,
    Heading,
    Html,
    Img,
    Link,
    Preview,
    Row,
    Section,
    Text,
} from '@react-email/components';

export interface NewsletterIssue {
    weekKey: string;
    exclusiveTank: { slug: string; hook: string; pickUrl: string };
    thisWeek: string;
    loreSpotlight: { title: string; body: string };
}

const DISPLAY_FONT = "'Arial Black', 'Franklin Gothic Heavy', Impact, 'Helvetica Neue', Arial, sans-serif";
const BODY_FONT = 'Georgia, "Times New Roman", serif';

const INK = '#111111';
const BLUE = '#1f6fb2';
const RED = '#c8342a';
const YELLOW = '#f5b731';

// The in-app Tank artifact (components/Fishtank.tsx) is a draggable, animated 3D cube -
// no email client runs JavaScript or renders drag/animation, so it can't be embedded as
// itself. TANK_GLASS/EMBER borrow that component's actual palette (dark slate glass,
// #ffc72c gold Ember glow) for a small static badge instead, so the exclusive pick still
// visually reads as "from the Tank" without pretending to be the real 3D object.
const TANK_GLASS = '#0f172a';
const EMBER = '#ffc72c';

// Small tiled dot pattern, layered over each panel's flat background-color via
// background-image. Pure CSS + a tiny inline SVG - no hosted asset, no VML. Clients
// that don't render background-image on table cells just show the flat panel color
// underneath, which still reads as a comic color block on its own.
const halftone = (dot: string) =>
    `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14'%3E%3Ccircle cx='7' cy='7' r='2' fill='${encodeURIComponent(dot)}'/%3E%3C/svg%3E")`;

// isFirst controls whether this panel draws its own top border. Every panel always
// draws its bottom border, so a stack of panels shares one gutter line between
// neighbors (comic-page style) instead of doubling up at each seam - a non-first
// panel's top edge relies entirely on the panel above it, which already drew that
// same line as its bottom border.
function panelStyle(bg: string, dot: string, isFirst: boolean) {
    const side = `4px solid ${INK}`;
    return {
        backgroundColor: bg,
        backgroundImage: halftone(dot),
        backgroundRepeat: 'repeat',
        borderTop: isFirst ? side : 'none',
        borderBottom: side,
        borderLeft: side,
        borderRight: side,
        padding: '24px',
    };
}

const styles = {
    pageBody: { backgroundColor: '#f0ede4', fontFamily: BODY_FONT, padding: '24px 0' },
    container: { maxWidth: '560px', margin: '0 auto', padding: '0 16px' },
    masthead: { margin: '0 0 20px' },
    weekTag: {
        display: 'inline-block',
        fontFamily: DISPLAY_FONT,
        fontWeight: 900,
        fontSize: '13px',
        letterSpacing: '0.06em',
        textTransform: 'uppercase' as const,
        color: INK,
        backgroundColor: '#ffffff',
        border: `2px solid ${INK}`,
        padding: '6px 12px',
        margin: '0',
    },

    heroPanel: { ...panelStyle(BLUE, 'rgba(255,255,255,0.35)', true), marginBottom: '0' },
    // The "from the Tank" badge - dark glass + gold Ember glow, nodding to the real
    // in-app artifact's palette (see TANK_GLASS/EMBER above) inside the otherwise flat
    // comic-panel treatment.
    tankBadge: {
        display: 'inline-block',
        fontFamily: DISPLAY_FONT,
        fontWeight: 900,
        fontSize: '11px',
        letterSpacing: '0.06em',
        textTransform: 'uppercase' as const,
        color: EMBER,
        backgroundColor: TANK_GLASS,
        border: `2px solid ${EMBER}`,
        borderRadius: '5px',
        padding: '6px 12px 6px 10px',
        margin: '0 0 14px',
    },
    tankBadgeDot: {
        display: 'inline-block',
        width: '7px',
        height: '7px',
        borderRadius: '50%',
        backgroundColor: EMBER,
        boxShadow: `0 0 6px 2px ${EMBER}`,
        marginRight: '7px',
    },
    heroHeadline: {
        fontFamily: DISPLAY_FONT,
        fontWeight: 900,
        fontSize: '26px',
        lineHeight: '1.15',
        color: '#ffffff',
        margin: '0 0 20px',
        textShadow: '2px 2px 0 rgba(0,0,0,0.35)',
    },
    ctaWrap: { margin: '0' },
    cta: {
        display: 'inline-block',
        fontFamily: DISPLAY_FONT,
        fontWeight: 900,
        fontSize: '15px',
        letterSpacing: '0.02em',
        textTransform: 'uppercase' as const,
        color: INK,
        backgroundColor: YELLOW,
        border: `3px solid ${INK}`,
        padding: '12px 22px',
        textDecoration: 'none',
    },

    weekPanel: { ...panelStyle(YELLOW, 'rgba(0,0,0,0.10)', false), marginBottom: '0' },
    lorePanel: { ...panelStyle(RED, 'rgba(255,255,255,0.22)', false), marginBottom: '20px' },

    panelCaptionDark: {
        display: 'inline-block',
        fontFamily: DISPLAY_FONT,
        fontWeight: 900,
        fontSize: '13px',
        letterSpacing: '0.05em',
        textTransform: 'uppercase' as const,
        color: INK,
        backgroundColor: '#ffffff',
        border: `2px solid ${INK}`,
        padding: '3px 9px',
        margin: '0 0 12px',
    },
    panelCaptionLight: {
        display: 'inline-block',
        fontFamily: DISPLAY_FONT,
        fontWeight: 900,
        fontSize: '13px',
        letterSpacing: '0.05em',
        textTransform: 'uppercase' as const,
        color: '#ffffff',
        backgroundColor: INK,
        padding: '3px 9px',
        margin: '0 0 12px',
    },
    bodyOnDark: { fontFamily: BODY_FONT, fontSize: '15px', lineHeight: '1.6', color: INK, margin: '0' },
    bodyOnRed: { fontFamily: BODY_FONT, fontSize: '15px', lineHeight: '1.6', color: '#fff3f1', margin: '0' },

    footer: { fontFamily: BODY_FONT, fontSize: '12px', color: '#8a8578', margin: '4px 0', textAlign: 'center' as const },
};

export default function NewsletterIssueEmail({ weekKey, exclusiveTank, thisWeek, loreSpotlight }: NewsletterIssue) {
    return (
        <Html>
            <Head />
            <Preview>{exclusiveTank.hook}</Preview>
            <Body style={styles.pageBody}>
                <Container style={styles.container}>
                    <Section style={styles.masthead}>
                        <Row>
                            <Column align="left" valign="middle">
                                <Img
                                    src="https://heatchecks.io/assets/images/heatchecks-logo-email.png"
                                    width="220"
                                    alt="Heatchecks"
                                    style={{ display: 'block', maxWidth: '220px', width: '100%', height: 'auto' }}
                                />
                            </Column>
                            <Column align="right" valign="middle">
                                <Text style={styles.weekTag}>Week {weekKey}</Text>
                            </Column>
                        </Row>
                    </Section>

                    <Section style={styles.heroPanel}>
                        <Text style={styles.tankBadge}>
                            <span style={styles.tankBadgeDot} />
                            Exclusive Tank Prop
                        </Text>
                        <Heading style={styles.heroHeadline}>{exclusiveTank.hook}</Heading>
                        <Section style={styles.ctaWrap}>
                            <Link href={exclusiveTank.pickUrl} style={styles.cta}>Make Your Call!</Link>
                        </Section>
                    </Section>

                    <Section style={styles.weekPanel}>
                        <Text style={styles.panelCaptionDark}>This Week</Text>
                        <Text style={styles.bodyOnDark}>{thisWeek}</Text>
                    </Section>

                    <Section style={styles.lorePanel}>
                        <Text style={styles.panelCaptionLight}>{loreSpotlight.title}</Text>
                        <Text style={styles.bodyOnRed}>{loreSpotlight.body}</Text>
                    </Section>

                    <Text style={styles.footer}>Heatchecks — the story is the product.</Text>
                    <Text style={styles.footer}>
                        <Link href="{{{RESEND_UNSUBSCRIBE_URL}}}" style={{ color: '#8a8578' }}>Unsubscribe</Link>
                    </Text>
                </Container>
            </Body>
        </Html>
    );
}
