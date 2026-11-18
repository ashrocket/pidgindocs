import { describe, expect, it } from 'vitest';
import { setupPage } from '../core/web/index';
import type { SetupStatus } from '../core/setup/status';

const status: SetupStatus = {
  ready: false,
  currentStep: 'microsoft365',
  microsoft365: { configured: false },
  onedrive: { configured: false },
  commute: { configured: false },
  gchat: { configured: false },
  matrix: { configured: false },
  push: { apns_configured: false, device_count: 0 },
};

describe('setup page permissions and independent connections', () => {
  it('shows teammates status and personal keys without shared credential forms', async () => {
    const html = await setupPage(status, { canEdit: false }).text();
    expect(html).toContain('Only a server owner or admin can change shared delivery settings.');
    expect(html).toContain('Generate API key');
    expect(html).not.toContain('name="client_secret"');
    expect(html).not.toContain('name="openai_api_key"');
  });

  it('allows audio setup before Microsoft 365 and keeps unchecked destinations disabled', async () => {
    const html = await setupPage(status, { canEdit: true }).text();
    expect(html).toContain('Configure audio');
    expect(html).toContain('name="openai_api_key"');
    expect(html).toContain('id="teams-fields" hidden');
    expect(html).toContain('name="teams_team_id" placeholder="Microsoft team GUID" data-required="true" disabled');
    expect(html).toContain('function toggleOutputFields(name)');
  });

  it('escapes server messages before placing them in the page', async () => {
    const html = await setupPage(status, { error: '<img src=x onerror=alert(1)>' }).text();
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('uses the tenant two-pigeon mark in setup navigation and diagram', async () => {
    const html = await setupPage(status, { brand: 'example' }).text();
    expect(html.match(/src="\/assets\/space-icon\/example"/g)).toHaveLength(2);
    expect(html).not.toContain('setup-brand-mark" aria-hidden="true">D');
  });
});
