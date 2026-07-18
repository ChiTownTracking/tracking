'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { DASHBOARD_LINKS } from './DashboardNav';

// Phase N1: the narrow-width dashboard nav — the four links collapse
// behind a menu button instead of wrapping mid-label in the header row.
// Same icon-button treatment as the header's theme toggle; menu items get
// comfortable tap-height padding (the audit flagged the inline links'
// ~28px targets). Rendered by DashboardNav below md; the inline link row
// takes over from md up.
export default function MobileNavMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Navigation closes the menu (pathname changes on link click); so do
  // Escape and any tap outside it.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (
        rootRef.current &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative md:hidden">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={open ? 'Close navigation menu' : 'Open navigation menu'}
        className="rounded-md p-2 text-text-muted hover:opacity-75"
      >
        {open ? <X size={18} /> : <Menu size={18} />}
      </button>
      {open && (
        <nav
          aria-label="Dashboard"
          className="absolute right-0 top-full z-[1100] mt-1 flex w-44 flex-col rounded-md border border-white/10 bg-panel p-1 shadow-lg"
        >
          {DASHBOARD_LINKS.map(({ href, label }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className="rounded-md px-3 py-2.5 text-sm"
                style={
                  active
                    ? {
                        background:
                          'color-mix(in srgb, var(--color-accent) 25%, transparent)',
                      }
                    : { color: 'var(--color-text-muted)' }
                }
              >
                {label}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
