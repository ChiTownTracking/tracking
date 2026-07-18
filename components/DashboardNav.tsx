'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import MobileNavMenu from './MobileNavMenu';

// Shared with MobileNavMenu — one source of truth for the nav's targets.
export const DASHBOARD_LINKS = [
  { href: '/dashboard', label: 'Live Map' },
  { href: '/dashboard/create-link', label: 'Create Link' },
  { href: '/dashboard/links', label: 'Links' },
  { href: '/dashboard/trips', label: 'Trips' },
] as const;

// Phase N1: below md the inline link row (which used to wrap mid-label at
// phone widths) yields to MobileNavMenu's collapsed menu button; from md
// up this is the same inline row as always, with slightly taller tap
// targets.
export default function DashboardNav() {
  const pathname = usePathname();

  return (
    <>
      <nav className="hidden items-center gap-1 md:flex">
        {DASHBOARD_LINKS.map(({ href, label }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className="rounded-md px-2.5 py-1.5 text-sm hover:opacity-80"
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
      <MobileNavMenu />
    </>
  );
}
