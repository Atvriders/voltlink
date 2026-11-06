// Unit coverage for web push wiring (N-PUSH): support classification,
// prepare/enable/unsubscribe flows against a mocked API client.

import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.fn();
vi.mock('../api/client', () => ({ api: apiMock }));

afterEach(() => vi.restoreAllMocks());

function mockRegistration() {
  return {
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(null),
      subscribe: vi.fn().mockResolvedValue({ toJSON: () => ({ endpoint: 'e1' }) }),
    },
  };
}

describe('pushSupport', () => {
  it('classifies insecure and unsupported contexts', async () => {
    window.matchMedia = (() => ({ matches: false })) as never;
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    const { pushSupport } = await import('./push');
    expect(pushSupport()).toBe('insecure-context');

    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
    expect(pushSupport()).toBe('unsupported');
  });

  it('classifies ios-without-standalone as needs-home-screen', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'userAgent', { value: 'iPhone Safari', configurable: true });
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
    delete (window as unknown as { PushManager?: unknown }).PushManager;
    Object.defineProperty(window, 'Notification', { value: {}, configurable: true });
    window.matchMedia = (() => ({ matches: false })) as never;
    Object.defineProperty(navigator, 'standalone', { value: false, configurable: true });
    const { pushSupport } = await import('./push');
    expect(pushSupport()).toBe('needs-home-screen');
  });
});

describe('push prepare/enable/unsubscribe', () => {
  it('prepares, subscribes with a VAPID key and unsubscribes', async () => {
    apiMock.mockResolvedValue({ enabled: true, publicKey: 'AQID', keyId: 'k1' });
    const push = await import('./push');
    const registration = mockRegistration();
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { register: vi.fn().mockResolvedValue(registration) },
      configurable: true,
    });
    await push.prepare();
    Object.defineProperty(Notification, 'requestPermission', {
      value: vi.fn().mockResolvedValue('granted'),
      configurable: true,
    });
    await push.enable();
    expect(registration.pushManager.subscribe).toHaveBeenCalled();
    expect(apiMock).toHaveBeenCalledWith('/api/v1/notifications/push/subscriptions', {
      method: 'PUT',
      body: { subscription: { endpoint: 'e1' }, keyId: 'k1' },
    });

    registration.pushManager.getSubscription = vi
      .fn()
      .mockResolvedValue({ endpoint: 'e1', unsubscribe: vi.fn() });
    await push.unsubscribePush();
    expect(apiMock).toHaveBeenCalledWith('/api/v1/notifications/push/subscriptions', {
      method: 'DELETE',
      body: { endpoint: 'e1' },
    });
  });

  it('refuses to enable when push is not configured or permission denied', async () => {
    apiMock.mockResolvedValue({ enabled: false, publicKey: '', keyId: '' });
    const push = await import('./push');
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { register: vi.fn().mockResolvedValue(mockRegistration()) },
      configurable: true,
    });
    await push.prepare();
    await expect(push.enable()).rejects.toThrow(/not configured/);

    apiMock.mockResolvedValue({ enabled: true, publicKey: 'AQID', keyId: 'k1' });
    await push.prepare();
    Object.defineProperty(Notification, 'requestPermission', {
      value: vi.fn().mockResolvedValue('denied'),
      configurable: true,
    });
    await expect(push.enable()).rejects.toThrow(/blocked/);
  });
});
