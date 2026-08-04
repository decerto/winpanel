import { describe, expect, it } from 'vitest';
import {
  AGENT_SERVICE_ID,
  PANEL_SERVICE_PREFIX,
  describePanelService,
  parseServiceQuery,
  sortForShutdown,
  sortForStartup,
  type PanelService,
} from '../src/windows/panel-services.js';

/**
 * These are the parts that decide what an uninstall has to stop. Getting the
 * parsing or the ordering wrong does not fail loudly — it silently leaves a
 * process running, which is the failure this module exists to prevent.
 */

/** A realistic slice of `sc.exe query type= service state= all` output. */
const SC_OUTPUT = [
  'SERVICE_NAME: Winmgmt',
  'DISPLAY_NAME: Windows Management Instrumentation',
  '        TYPE               : 20  WIN32_SHARE_PROCESS',
  '        STATE              : 4  RUNNING',
  '                                (STOPPABLE, PAUSABLE, ACCEPTS_SHUTDOWN)',
  '        WIN32_EXIT_CODE    : 0  (0x0)',
  '',
  'SERVICE_NAME: winpanel-agent',
  'DISPLAY_NAME: WinPanel',
  '        TYPE               : 10  WIN32_OWN_PROCESS',
  '        STATE              : 4  RUNNING',
  '        WIN32_EXIT_CODE    : 0  (0x0)',
  '',
  'SERVICE_NAME: winpanel-caddy',
  'DISPLAY_NAME: WinPanel web server',
  '        TYPE               : 10  WIN32_OWN_PROCESS',
  '        STATE              : 4  RUNNING',
  '',
  'SERVICE_NAME: winpanel-site-kitora-blue',
  'DISPLAY_NAME: kitora.io',
  '        TYPE               : 10  WIN32_OWN_PROCESS',
  '        STATE              : 1  STOPPED',
  '',
  'SERVICE_NAME: winpanel-site-kitora-green',
  'DISPLAY_NAME: kitora.io',
  '        TYPE               : 10  WIN32_OWN_PROCESS',
  '        STATE              : 3  STOP_PENDING',
  '',
].join('\r\n');

describe('parseServiceQuery', () => {
  const services = parseServiceQuery(SC_OUTPUT, PANEL_SERVICE_PREFIX);

  it("ignores services that are not the panel's", () => {
    expect(services.map((service) => service.id)).not.toContain('Winmgmt');
  });

  it('finds every panel service with its state', () => {
    expect(services).toEqual([
      expect.objectContaining({ id: 'winpanel-agent', state: 'running' }),
      expect.objectContaining({ id: 'winpanel-caddy', state: 'running' }),
      expect.objectContaining({ id: 'winpanel-site-kitora-blue', state: 'stopped' }),
      expect.objectContaining({ id: 'winpanel-site-kitora-green', state: 'stopping' }),
    ]);
  });

  it('survives a block with no state line rather than dropping the service', () => {
    // A service that cannot be interrogated is still one that blocks removal,
    // so reporting it as unknown beats not reporting it at all.
    const partial = parseServiceQuery(
      'SERVICE_NAME: winpanel-stalwart\r\nDISPLAY_NAME: Mail\r\n',
      PANEL_SERVICE_PREFIX,
    );
    expect(partial).toEqual([expect.objectContaining({ id: 'winpanel-stalwart', state: 'unknown' })]);
  });

  it('returns nothing for output with no services in it', () => {
    expect(parseServiceQuery('', PANEL_SERVICE_PREFIX)).toEqual([]);
  });
});

describe('describePanelService', () => {
  it('names the panel itself', () => {
    expect(describePanelService(AGENT_SERVICE_ID)).toEqual({
      label: 'Control panel',
      kind: 'panel',
    });
  });

  it('takes component names from the catalogue rather than repeating them', () => {
    expect(describePanelService('winpanel-caddy')).toEqual({
      label: 'Web server',
      kind: 'component',
    });
    expect(describePanelService('winpanel-stalwart')).toEqual({
      label: 'Mail server',
      kind: 'component',
    });
  });

  it('reads the slug and colour out of a site service, dashes and all', () => {
    expect(describePanelService('winpanel-site-my-shop-green')).toEqual({
      label: 'Website: my-shop (green)',
      kind: 'site',
    });
  });

  it('falls back to the raw id for something it does not recognise', () => {
    expect(describePanelService('winpanel-something-new')).toEqual({
      label: 'winpanel-something-new',
      kind: 'other',
    });
  });
});

describe('sortForShutdown', () => {
  it('stops websites first and the panel last', () => {
    const services: PanelService[] = [
      { id: 'winpanel-agent', label: 'Control panel', kind: 'panel', state: 'running' },
      { id: 'winpanel-caddy', label: 'Web server', kind: 'component', state: 'running' },
      { id: 'winpanel-site-a-blue', label: 'Website: a (blue)', kind: 'site', state: 'running' },
    ];

    // The panel is the only thing that can report what happened, and the web
    // server is what a site is reached through, so both outlive the sites.
    expect(sortForShutdown(services).map((service) => service.kind)).toEqual([
      'site',
      'component',
      'panel',
    ]);
  });
});

describe('sortForStartup', () => {
  it('brings up what a website depends on before the website', () => {
    const services: PanelService[] = [
      { id: 'winpanel-site-a-blue', label: 'Website: a (blue)', kind: 'site', state: 'stopped' },
      { id: 'winpanel-agent', label: 'Control panel', kind: 'panel', state: 'running' },
      { id: 'winpanel-caddy', label: 'Web server', kind: 'component', state: 'stopped' },
    ];

    // Starting a site before the web server that fronts it leaves a window
    // where the site is up and unreachable, which reads as a broken deploy.
    expect(sortForStartup(services).map((service) => service.kind)).toEqual([
      'panel',
      'component',
      'site',
    ]);
  });
});
