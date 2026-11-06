// Unit coverage for lib modules: web push wiring, SSE realtime singleton,
// vehicle selection with localStorage and URL params.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('pushSupport', () => {
  it('classifies insecure contexts', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    const { pushSupport } = await import('./push');
    expect(pushSupport()).toBe('insecure-context');
  });

  it('classifies unsupported contexts', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
    window.matchMedia = (() => ({ matches: false })) as never;
    const { pushSupport } = await import('./push');
    expect(pushSupport()).toBe('unsupported');
  });
});

describe('realtime singleton', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts, receives events, errors, reconnects and stops', async () => {
    const listeners = {
      vehicle_state: vi.fn(),
      notification: vi.fn(),
      command_finished: vi.fn(),
    };
    class FakeES {
      static instances: FakeES[] = [];
      onerror: (() => void) | null = null;
      handlers = new Map<string, () => void>();
      closed = false;
      constructor() {
        FakeES.instances.push(this);
      }
      addEventListener(name: string, fn: () => void) {
        this.handlers.set(name, fn);
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal('EventSource', FakeES);
    const rt = await import('./realtime');
    rt.realtimeStart(listeners);
    expect(FakeES.instances.length).toBe(1);
    FakeES.instances[0]!.handlers.get('vehicle_state')?.();
    expect(listeners.vehicle_state).toHaveBeenCalled();
    // A second start is a no-op while a stream exists.
    rt.realtimeStart(listeners);
    expect(FakeES.instances.length).toBe(1);
    // Error closes and reconnects on a timer.
    vi.useFakeTimers();
    FakeES.instances[0]!.onerror?.();
    expect(FakeES.instances[0]!.closed).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(FakeES.instances.length).toBe(2);
    rt.realtimeStop();
    vi.advanceTimersByTime(10_000);
    expect(FakeES.instances.length).toBe(2);
  });
});

describe('vehicleSelection', () => {
  beforeEach(() => localStorage.clear());

  it('writes and reads recent picks (max 5, newest first, de-duped)', async () => {
    const { writeRecent, readRecent } = await import('./vehicleSelection');
    writeRecent('u1', 'a');
    writeRecent('u1', 'b');
    writeRecent('u1', 'c');
    writeRecent('u1', 'd');
    writeRecent('u1', 'e');
    const recents = writeRecent('u1', 'a');
    expect(recents).toEqual(['a', 'e', 'd', 'c', 'b']);
    expect(readRecent('u1')).toEqual(['a', 'e', 'd', 'c', 'b']);
    expect(readRecent('u2')).toEqual([]);
  });

  it('survives broken localStorage', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { writeRecent, readRecent } = await import('./vehicleSelection');
    expect(readRecent('u1')).toEqual([]);
    expect(writeRecent('u1', 'x')).toEqual(['x']);
    get.mockRestore();
    set.mockRestore();
  });
});
