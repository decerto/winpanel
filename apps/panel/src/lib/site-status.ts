/**
 * What to say about a website at a glance.
 *
 * A port is allocated the moment a site is created, so it proves nothing on
 * its own. Only a successful deployment justifies the word "live" — and the
 * word is always shown next to the colour, never instead of it.
 */
export interface SiteStatus {
  label: string;
  /** Background class for the dot. */
  dot: string;
  /** Text colour class for the label. */
  text: string;
}

export function siteStatus(site: {
  lastDeploymentStatus: string | null;
  activePort: number | null;
  runtime?: string;
}): SiteStatus {
  switch (site.lastDeploymentStatus) {
    case 'succeeded':
      return {
        // A static site has no process and therefore no port; naming one
        // would be inventing a detail that does not exist.
        label: site.runtime !== 'static' && site.activePort ? `Live on ${site.activePort}` : 'Live',
        dot: 'bg-ok',
        text: 'text-ok',
      };
    case 'failed':
      return { label: 'Last deploy failed', dot: 'bg-danger', text: 'text-danger' };
    case 'needs-setup':
      // The files are there; only a setting is missing. Not a failure.
      return { label: 'Needs setup', dot: 'bg-warn', text: 'text-warn' };
    case 'running':
    case 'pending':
      return { label: 'Deploying', dot: 'bg-info', text: 'text-info' };
    default:
      return { label: 'Not published yet', dot: 'bg-idle', text: 'text-ink-faint' };
  }
}

export const RUNTIME_LABEL: Record<string, string> = {
  node: 'Node.js app',
  static: 'Static files',
  dotnet: '.NET app',
  proxy: 'Proxied elsewhere',
};
