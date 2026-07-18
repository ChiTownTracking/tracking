'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/dashboard', label: 'Live Map' },
  { href: '/dashboard/create-link', label: 'Create Link' },
  { href: '/dashboard/links', label: 'Links' },
  { href: '/dashboard/trips', label: 'Trips' },
] as const;

export default function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1">
      {LINKS.map(({ href, label }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className="rounded-md px-2.5 py-1 text-sm hover:opacity-80"
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
  );
}
