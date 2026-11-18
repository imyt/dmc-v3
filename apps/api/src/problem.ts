import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiError } from '@dmc/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Every error leaves as application/problem+json with a trace id. Internal details never reach the caller. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const req = http.getRequest<FastifyRequest>();
    const traceId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    let err: ApiError;
    if (e instanceof ApiError) err = e;
    else if (e instanceof HttpException) {
      const s = e.getStatus();
      err = new ApiError(s === 404 ? 'not_found' : s === 401 ? 'unauthenticated' : s === 403 ? 'forbidden' : s < 500 ? 'validation_failed' : 'internal', s === 404 ? 'No such route' : undefined);
    } else { err = new ApiError('internal'); console.error(JSON.stringify({ level: 'error', traceId, message: (e as Error)?.message })); }
    void reply.status(err.status).header('content-type', 'application/problem+json').send(err.toProblem(traceId));
  }
}
