import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import type { GlossaryEntry } from '../data/glossary-schema';

interface Props {
  entry: GlossaryEntry;
  /** The entry's shareable address, from `glossaryEntryHref`. */
  href: string;
}

/**
 * The optional inline explanation of one naming term.
 *
 * **It is never the only copy of anything.** The canonical text lives on the
 * glossary route, this discloses `short` alone, and the panel's first action is
 * a link to the full entry. That is what makes it optional in the sense issue
 * #44 asks for: removing it from a page loses an affordance, not a fact.
 *
 * **It is not a hover tooltip, and hover is not wired at all.** There is no
 * `onMouseEnter` here by design — the accessibility requirement is that
 * definitions are reachable without a pointer, and a control that also opens on
 * hover invites exactly the essential-content-in-a-tooltip pattern the issue
 * rules out. Opening is a click or a key press on a focusable control, Escape
 * closes it and returns focus to the trigger, and moving focus out of the
 * component closes it too.
 *
 * **The trigger is a link that behaves as a disclosure**, rather than a button.
 * A button with no JavaScript is inert, which would leave a reader who never
 * receives the hydration bundle with an affordance that does nothing. As a link
 * it navigates to the full entry instead, so the no-JavaScript path degrades to
 * the canonical text rather than to silence; `aria-expanded` is valid on
 * `role="link"`, so the disclosed state is still announced. Modified clicks —
 * Ctrl, Cmd, Shift, Alt, or any non-primary button — are left alone so
 * "open in a new tab" keeps working.
 */
export default function GlossaryHint({ entry, href }: Props) {
  const [open, setOpen] = useState(false);
  const reactId = useId();
  const panelId = `glossary-hint-panel-${reactId}`;
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <span
      className="glossary-hint"
      ref={wrapperRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close(true);
        }
      }}
      onBlur={(event) => {
        // Focus left the component entirely, rather than moving between the
        // trigger and the panel's link.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <a
        ref={triggerRef}
        className="glossary-hint-trigger"
        href={href}
        aria-controls={panelId}
        aria-expanded={open}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (event.button !== 0) return;

          event.preventDefault();
          setOpen((previous) => !previous);
        }}
      >
        <Info size={14} aria-hidden="true" />
        <span className="visually-hidden">{`What “${entry.term}” means`}</span>
      </a>

      <span className="glossary-hint-panel" id={panelId} role="note" hidden={!open}>
        <span className="glossary-hint-term">{entry.term}</span>
        <span className="glossary-hint-short">{entry.short}</span>
        <a className="glossary-hint-full" href={href}>
          Read the full entry, with its sources
        </a>
      </span>
    </span>
  );
}
