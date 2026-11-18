import { metrics } from '@opentelemetry/api';

const meter = () => metrics.getMeter('dmc');

/** Standard metrics every module uses; names are fixed so dashboards work across modules. */
export const httpRequests = () => meter().createCounter('dmc_http_requests_total', { description: 'HTTP requests by module, route and status' });
export const httpDuration = () => meter().createHistogram('dmc_http_request_duration_ms', { unit: 'ms' });
export const jobsProcessed = () => meter().createCounter('dmc_jobs_processed_total', { description: 'Queue jobs by name and outcome' });
export const jobDuration = () => meter().createHistogram('dmc_job_duration_ms', { unit: 'ms' });
