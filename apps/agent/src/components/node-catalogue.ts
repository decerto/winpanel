import { z } from 'zod';

export const NodeVersionDefinition = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  codename: z.string().min(1),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type NodeVersionDefinition = z.infer<typeof NodeVersionDefinition>;

export const NODE_VERSION_CATALOGUE: readonly NodeVersionDefinition[] = [
  {
    version: '24.18.1',
    codename: 'Krypton',
    url: 'https://nodejs.org/dist/v24.18.1/node-v24.18.1-win-x64.zip',
    sha256: 'af4a0651a26f04ac240f00fec872f305547ca2aa56301c41dfd63a29eb2ab836',
  },
  {
    version: '22.21.1',
    codename: 'Jod',
    url: 'https://nodejs.org/dist/v22.21.1/node-v22.21.1-win-x64.zip',
    sha256: '3c624e9fbe07e3217552ec52a0f84e2bdc2e6ffa7348f3fdfb9fbf8f42e23fcf',
  },
  {
    version: '20.19.5',
    codename: 'Iron',
    url: 'https://nodejs.org/dist/v20.19.5/node-v20.19.5-win-x64.zip',
    sha256: 'c48159529572a5a947eef2d55d6485dfdc4ce8e67216402e2f6de52ad5d95695',
  },
];

export function findNodeVersion(version: string): NodeVersionDefinition | undefined {
  return NODE_VERSION_CATALOGUE.find((entry) => entry.version === version.replace(/^v/, '').trim());
}