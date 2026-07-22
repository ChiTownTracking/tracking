'use client';

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

// Presentational only (untested, verified visually — same convention as
// VehicleMarkerIcon/FleetMap): all credential/rate-limit logic lives behind
// POST /api/login.
export default function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Client-side reveal only — never changes how the value is submitted.
  // Defaults hidden, an opt-in reveal.
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        // Deliberately generic — never hint at which field was wrong.
        setError(
          res.status === 429
            ? 'Too many attempts. Try again shortly.'
            : 'Invalid credentials',
        );
        return;
      }
      window.location.assign('/dashboard');
    } catch {
      setError('Request failed — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full max-w-sm rounded-lg bg-panel p-8">
      <h1 className="font-heading text-xl font-medium">
        ChiTown Tracking — Fleet Dispatch
      </h1>
      <p className="mt-1 text-sm text-text-muted">
        Staff sign-in. Sessions end when the browser closes.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <label className="block">
          <span className="mb-1.5 block text-sm text-text-muted">Username</span>
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            autoComplete="username"
            autoFocus
            className="w-full rounded-md border border-white/10 bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm text-text-muted">Password</span>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
              className="w-full rounded-md border border-white/10 bg-bg px-3 py-2 pr-10 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowPassword((shown) => !shown)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-text-muted hover:text-text"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>

        {error && (
          <p role="alert" className="text-sm" style={{ color: 'var(--color-alert)' }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="mt-1 rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--color-accent)' }}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
