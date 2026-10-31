// §1.4 location search: 300 ms debounce, 3+ characters, AbortController for
// stale requests, result-count announcement, and local fictional POIs in demo
// mode (no network, no provider).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../../api/client';
import { useAnnounce } from '../../lib/announcer';
import { useClientConfig } from './useMapStyle';

interface GeoResult {
  label: string;
  lat: number;
  lon: number;
  kind: string;
}

const DEMO_POIS: GeoResult[] = [
  { label: 'VoltLink HQ', lat: 39.0734, lon: -104.6211, kind: 'office' },
  { label: 'Denver Union Station', lat: 39.7532, lon: -105.0002, kind: 'transit' },
  { label: 'Boulder Charging Hub', lat: 40.015, lon: -105.2705, kind: 'charger' },
  { label: 'Red Rocks Amphitheatre', lat: 39.6655, lon: -105.2056, kind: 'venue' },
  { label: 'Cherry Creek Mall', lat: 39.7168, lon: -104.9551, kind: 'shop' },
];

export default function GeocodeSearch({ onChoose }: { onChoose: (r: GeoResult) => void }) {
  const { data: config } = useClientConfig();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GeoResult[]>([]);
  const [open, setOpen] = useState(false);
  const announce = useAnnounce();
  const abortRef = useRef<AbortController | null>(null);

  const demoMode = (config?.map.mode ?? 'demo') === 'demo' || !config?.geocoder.enabled;

  const localResults = useMemo(
    () =>
      q.trim().length < 3
        ? []
        : DEMO_POIS.filter((p) => p.label.toLowerCase().includes(q.trim().toLowerCase())),
    [q],
  );

  useEffect(() => {
    if (demoMode) {
      setResults(localResults);
      return;
    }
    if (q.trim().length < 3) {
      setResults([]);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const t = setTimeout(async () => {
      try {
        const data = await api<GeoResult[]>(`/api/v1/geocode?q=${encodeURIComponent(q.trim())}`);
        if (!ctrl.signal.aborted) {
          setResults(data);
          announce(`${data.length} search result${data.length === 1 ? '' : 's'}`);
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) setResults([]);
      }
    }, 300);
    return () => {
      clearTimeout(t);
    };
  }, [q, demoMode, localResults, announce]);

  const enabled = config?.geocoder.enabled || demoMode;
  if (!enabled) return null;

  return (
    <div className="relative w-72 max-w-full">
      <div className="flex items-center gap-1 rounded-lg border border-control bg-surface px-2">
        <Search size={13} className="text-subtle" />
        <input
          aria-label="Search locations"
          placeholder="Search locations…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          className="w-full bg-transparent py-1.5 text-sm outline-none placeholder:text-faint"
        />
      </div>
      {open && q.trim().length >= 3 && (
        <ul
          role="listbox"
          aria-label="Location results"
          className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-control bg-surface shadow-lg"
        >
          {results.length === 0 && <li className="px-3 py-2 text-xs text-faint">No matches.</li>}
          {results.map((r) => (
            <li key={`${r.lat}:${r.lon}:${r.label}`}>
              <button
                type="button"
                role="option"
                className="w-full px-3 py-2 text-left text-sm hover:bg-panel2"
                onClick={() => {
                  setOpen(false);
                  onChoose(r);
                }}
              >
                {r.label}
                <span className="ml-1.5 text-xs capitalize text-faint">{r.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
