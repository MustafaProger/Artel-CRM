import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPushDiagnostics, inspectPushCapabilities, type PushCapabilityInput } from '../web/src/push-client';

const available: PushCapabilityInput = { secureContext: true, serviceWorker: true, pushManager: true, notification: true, permission: 'granted' };

test('push support identifies each missing capability independently of permission or browser name', () => {
  assert.equal(inspectPushCapabilities(available).supported, true);
  for (const feature of ['secureContext', 'serviceWorker', 'pushManager', 'notification'] as const) {
    const result = inspectPushCapabilities({ ...available, [feature]: false });
    assert.equal(result.supported, false, feature);
    assert.deepEqual(result.missing, [feature]);
  }
  assert.deepEqual(inspectPushCapabilities({ ...available, serviceWorker: false, pushManager: false }).missing, ['serviceWorker', 'pushManager']);
  for (const permission of ['default', 'denied']) assert.equal(inspectPushCapabilities({ ...available, permission }).supported, true);
  assert.equal(inspectPushCapabilities({ ...available, notification: false }).permission, 'unavailable');
});

test('Huawei identity supplies guidance without overriding actual support detection', () => {
  const userAgent = 'Mozilla/5.0 (Linux; Android 12; HUAWEI) AppleWebKit/537.36 Chrome/114.0.0.0 Mobile Safari/537.36 HuaweiBrowser/16.0.8.301';
  const supported = inspectPushCapabilities({ ...available, userAgent });
  assert.equal(supported.browserName, 'Huawei Browser');
  assert.equal(supported.browserVersion, '16.0.8.301');
  assert.equal(supported.supported, true);
  const unsupported = inspectPushCapabilities({ ...available, userAgent, pushManager: false });
  assert.equal(unsupported.supported, false);
  assert.deepEqual(unsupported.missing, ['pushManager']);
});

test('iOS home screen guidance detects iPhone and desktop-mode iPad without inferring successful delivery', () => {
  const phone = inspectPushCapabilities({ ...available, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) Version/18.4 Mobile/15E148 Safari/604.1' });
  assert.equal(phone.ios, true);
  assert.equal(phone.installed, false);
  assert.equal(phone.browserName, 'Safari');
  const ipad = inspectPushCapabilities({ ...available, platform: 'MacIntel', maxTouchPoints: 5, standalone: true });
  assert.equal(ipad.ios, true);
  assert.equal(ipad.installed, true);
  assert.equal(inspectPushCapabilities({ ...available, platform: 'MacIntel', maxTouchPoints: 0 }).ios, false);
  assert.match(formatPushDiagnostics(ipad), /Доставка на телефон этой проверкой не подтверждается/);
});

test('copied diagnostics whitelist fields and never retain raw user agent, URL, endpoint, keys or account/session data', () => {
  const privateValue = 'PRIVATE_VALUE_MUST_NOT_APPEAR';
  const input = {
    ...available, userAgent: `Chrome/130.0.1.2 ${privateValue}`, platform: privateValue,
    permission: privateValue, endpoint: privateValue, keys: { p256dh: privateValue, auth: privateValue },
    accountId: privateValue, session: privateValue, url: privateValue,
  };
  const result = inspectPushCapabilities(input);
  assert.equal(result.permission, 'default');
  assert.equal(result.browserName, 'Chrome');
  assert.equal(result.browserVersion, '130.0.1.2');
  assert.deepEqual(Object.keys(result).sort(), ['browserName', 'browserVersion', 'installed', 'ios', 'missing', 'notification', 'permission', 'pushManager', 'secureContext', 'serviceWorker', 'supported'].sort());
  assert.equal(JSON.stringify(result).includes(privateValue), false);
  assert.equal(formatPushDiagnostics(result).includes(privateValue), false);
  assert.equal(formatPushDiagnostics(inspectPushCapabilities({ ...input, userAgent: privateValue })).includes(privateValue), false);
});
