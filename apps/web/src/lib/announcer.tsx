// AnnouncerProvider (guide 07 §3.4, F-A11Y): two visually hidden live regions.
// announce() clears then re-sets the text on the next frame so a repeated
// message is read again by screen readers.

import { createContext, useContext, useRef, useState, type ReactNode } from 'react';

type Kind = 'polite' | 'assertive';
const AnnouncerContext = createContext<(text: string, kind?: Kind) => void>(() => undefined);

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const timer = useRef<number | null>(null);
  const announce = (text: string, kind: Kind = 'polite') => {
    const set = kind === 'assertive' ? setAssertive : setPolite;
    set('');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => set(text), 50);
  };
  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      <div className="vl-sr-only" role="status" aria-live="polite">
        {polite}
      </div>
      <div className="vl-sr-only" role="alert" aria-live="assertive">
        {assertive}
      </div>
    </AnnouncerContext.Provider>
  );
}

export function useAnnounce(): (text: string, kind?: Kind) => void {
  return useContext(AnnouncerContext);
}
