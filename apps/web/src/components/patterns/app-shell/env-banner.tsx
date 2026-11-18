import type { DmcEnv } from '@/lib/env';

const TEXT: Record<Exclude<DmcEnv, 'prod'>, string> = {
  local: 'Local environment. Data here is test data.',
  uat: 'UAT environment. Policies run in shadow until signed off.',
};

/** Shown in local and UAT only, so nobody mistakes them for production. */
export function EnvBanner({ env }: { env: DmcEnv }) {
  if (env === 'prod') return null;
  return (
    <div role="status" data-env={env} className="bg-foreground px-4 py-1 text-center text-xs font-medium text-background">
      {TEXT[env]}
    </div>
  );
}
