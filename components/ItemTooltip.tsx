// The item description tooltip: a couple of sentences about an object, shown wherever
// items are listed (the Inventory modal's four tabs, both food shops, the Feed modal).
// Copy lives in items_catalog config.description - one key name across every item
// type, so this component never branches on what kind of thing it's describing.
//
// WHY IT IS A BUTTON, NOT A `title` OR A PURE CSS :hover.
// Hover is half the requirement; the other half is touch, which has no hover at all.
// The native `title` attribute does nothing on touch, can't be styled to match the
// game, and waits about a second before appearing. So the trigger is a real
// <button>: mouse gets enter/leave, touch gets a tap toggle, and keyboard gets
// focus + Enter for free because it was a button all along.
//
// WHAT THE TRIGGER WRAPS - and what it must NOT.
// Every row this lands in already has its own action: the shop row has Buy, the Feed
// row feeds the pet. Wrapping the whole row would mean a tap on touch couldn't tell
// "read about this" from "spend 60 Ember on this". So callers wrap the item's
// IDENTITY (its thumbnail and name) and leave the action controls outside as
// siblings - nested buttons are invalid HTML anyway, the same constraint that keeps
// PetWidget's "!" badge a sibling of the pet rather than a child.
//
// OPEN STATE IS THE CALLER'S, deliberately. The list owns which key is open, so
// opening one tooltip closes the previous one without any cross-talk between rows.

import React, { useEffect, useId, useRef } from 'react';
import './ItemTooltip.css';

interface ItemTooltipProps {
    // items_catalog config.description. Null/empty renders the children bare - no
    // trigger, no affordance, nothing to tab to.
    description: string | null;
    // Accessible name for the trigger, e.g. the item's display name.
    label: string;
    open: boolean;
    // Fired for both "open me" and "close me"; the caller stores at most one open key.
    onToggle: (open: boolean) => void;
    // Flip the bubble BELOW the trigger. The lists scroll inside .tank-modal-body, so
    // the first row has nothing above it to grow into and would clip at the top edge.
    below?: boolean;
    children: React.ReactNode;
}

export const ItemTooltip: React.FC<ItemTooltipProps> = ({
    description,
    label,
    open,
    onToggle,
    below = false,
    children,
}) => {
    const id = useId();
    const wrapRef = useRef<HTMLDivElement>(null);

    // Escape and outside-taps close the tooltip and STOP THERE. Both listeners are
    // capture-phase so this layer resolves before the modal's own document-level
    // Escape handler, which would otherwise close the whole inventory out from under
    // someone in the middle of reading. Same "peel back one layer at a time" contract
    // the pet widget documents for its bubble.
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            onToggle(false);
        };
        const onPointerDown = (e: PointerEvent) => {
            if (wrapRef.current?.contains(e.target as Node)) return;
            onToggle(false);
        };
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('pointerdown', onPointerDown, true);
        };
    }, [open, onToggle]);

    if (!description) return <>{children}</>;

    return (
        <div className="item-tooltip" ref={wrapRef}>
            <button
                type="button"
                className="item-tooltip__trigger"
                aria-expanded={open}
                aria-controls={id}
                aria-label={`${label} — what is this?`}
                onClick={(e) => {
                    // The row underneath may be clickable (the Feed modal feeds on row
                    // click); reading about an item is not choosing it.
                    e.stopPropagation();
                    onToggle(!open);
                }}
                // Mouse only. A touch tap also emits pointerenter, and letting it open
                // here would fight the click handler below - open on enter, then
                // toggle straight back closed - so a tap would appear to do nothing.
                onPointerEnter={(e) => { if (e.pointerType === 'mouse') onToggle(true); }}
                onPointerLeave={(e) => { if (e.pointerType === 'mouse') onToggle(false); }}
                // Keyboard focus only, for the same reason. Tapping or clicking a
                // button also focuses it, and focus lands BEFORE click - so an
                // unconditional onFocus would open the tooltip and the click would
                // immediately toggle it shut, which is precisely the tap-does-nothing
                // bug. :focus-visible is the browser's own "this focus came from the
                // keyboard" answer, so Tab opens it and a tap leaves it to the click.
                onFocus={(e) => { if (e.target.matches(':focus-visible')) onToggle(true); }}
                onBlur={() => onToggle(false)}
            >
                {children}
            </button>
            <div
                id={id}
                role="tooltip"
                className={`item-tooltip__bubble${below ? ' item-tooltip__bubble--below' : ''}`}
                hidden={!open}
            >
                {description}
            </div>
        </div>
    );
};

export default ItemTooltip;
