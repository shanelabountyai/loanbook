'use client';

/** Flips the loan screens between light and dark and remembers it in a cookie the layout reads, so there is no flash on the next load. */
export function ThemeToggle() {
  return (
    <button
      type="button"
      onClick={() => {
        const lb = document.querySelector<HTMLElement>('.lb')!;
        const dark = lb.dataset.theme ? lb.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
        lb.dataset.theme = dark ? 'light' : 'dark';
        document.cookie = `lb-theme=${lb.dataset.theme}; path=/; max-age=31536000; samesite=lax`;
      }}
    >
      Light / dark
    </button>
  );
}
