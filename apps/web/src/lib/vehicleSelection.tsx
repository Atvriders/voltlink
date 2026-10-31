// §2.8 vehicle selection: the /vehicles/:id URL wins, then ?vehicle=, then the
// most recent per-device pick (localStorage). Map, Battery and Charging read
// the selected vehicle and write ?vehicle= when it changes.
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

interface SelectionState {
  selectedId: string | null;
  setVehicle: (id: string) => void;
}

const Ctx = createContext<SelectionState>({ selectedId: null, setVehicle: () => undefined });

const RECENT_KEY_PREFIX = 'voltlink:recent-vehicles:';

function readRecents(userId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(`${RECENT_KEY_PREFIX}${userId}`) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function writeRecent(userId: string, id: string): string[] {
  const next = [id, ...readRecents(userId).filter((v) => v !== id)].slice(0, 5);
  try {
    localStorage.setItem(`${RECENT_KEY_PREFIX}${userId}`, JSON.stringify(next));
  } catch {
    /* private mode */
  }
  return next;
}

export function readRecent(userId: string): string[] {
  return readRecents(userId);
}

export function SelectedVehicleProvider({
  userId,
  children,
}: {
  userId: string;
  children: React.ReactNode;
}) {
  const [params, setParams] = useSearchParams();
  const urlVehicle = params.get('vehicle');
  const [local] = useState(() => (urlVehicle ? null : (readRecents(userId)[0] ?? null)));
  const selectedId = urlVehicle ?? local;
  const setVehicle = useCallback(
    (id: string) => {
      writeRecent(userId, id);
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('vehicle', id);
        return next;
      });
    },
    [userId, setParams],
  );
  const value = useMemo(() => ({ selectedId, setVehicle }), [selectedId, setVehicle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSelectedVehicle(): SelectionState {
  return useContext(Ctx);
}
