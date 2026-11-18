import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuthGuard } from './auth.js';
import { CatalogController, HealthController, SearchController } from './catalog.controller.js';
import { DelegationsController } from './delegations.controller.js';
import { ScopesController } from './scopes.controller.js';
import { DatasetsController } from './datasets.controller.js';
import { ClassificationsController } from './classifications.controller.js';
import { AdminController } from './admin.controller.js';
import { SyncController } from './sync.controller.js';
import { DashboardController } from './dashboard.controller.js';
import { AuthController } from './auth.controller.js';
import { PoliciesController } from './policies.controller.js';
import { InboxController } from './inbox.controller.js';
import { EvidenceController } from './evidence.controller.js';
import { RequirementsController } from './requirements.controller.js';
import { DEPS, type ApiDeps } from './context.js';
import { ProblemFilter } from './problem.js';

export async function createApi(deps: ApiDeps): Promise<NestFastifyApplication> {
  @Module({ controllers: [HealthController, SearchController, CatalogController, EvidenceController, RequirementsController, InboxController, ScopesController, DatasetsController, ClassificationsController, AdminController, SyncController, DashboardController, AuthController, PoliciesController, DelegationsController], providers: [{ provide: DEPS, useValue: deps }, AuthGuard] })
  class ApiModule {}
  const app = await NestFactory.create<NestFastifyApplication>(ApiModule, new FastifyAdapter(), { logger: false });
  app.useGlobalFilters(new ProblemFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
