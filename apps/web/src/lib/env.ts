export type DmcEnv = 'local' | 'uat' | 'prod';

/** Which deployment this is. Set VITE_DMC_ENV at build time; anything unknown is treated as local so a mistake is visible, not silent. */
export function currentEnv(raw: string | undefined = import.meta.env?.VITE_DMC_ENV): DmcEnv {
  return raw === 'prod' || raw === 'uat' ? raw : 'local';
}
