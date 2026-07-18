// Shared dashboard-form input styling, extracted from create-link when the
// stop picker and vehicle picker became reusable components.

export const fieldInputClass =
  'w-full rounded-md border border-white/10 bg-panel px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none';

// Inputs inside a stop card sit on bg-panel, so they use bg-bg for contrast
// (same treatment as the login form's fields).
export const stopInputClass =
  'w-full rounded-md border border-white/10 bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none';
