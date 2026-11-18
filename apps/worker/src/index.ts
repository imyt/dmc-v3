// @dmc/app-worker — deployable: worker
export * from './compose.js';
export * from './ingest.js';
export * from './person-refs.js';
export const PACKAGE = '@dmc/app-worker' as const;
export * from './run.js';
export * from './migrate.js';
export { startWorkerProcess, loadSyncJobs, logNotify, main, type StartedWorker } from './main.js';
export * from './scope-links.js';
export * from './derive.js';
export { SmtpMailer, logMailer, jsonTransport } from './mail.js';
export { EmailNotifications, Recipients, loadRecipientConfig, mailNotify, compose as composeEmail } from './notifications.js';
