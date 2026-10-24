import { Injectable, RequestMethod, type OnApplicationBootstrap } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { API_PREFIX, isUnprefixedPath } from '../../bootstrap/routes.js';
import { POLICY_METADATA, type RoutePolicy } from './policy.decorator.js';

export interface RouteEntry {
  method: string;
  path: string;
  controller: string;
  handler: string;
  policy: RoutePolicy | null;
}

function joinPath(...parts: (string | undefined)[]): string {
  const joined = parts
    .flatMap((part) => (part ?? '').split('/'))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

/**
 * Lists every HTTP route with its declared policy, and stops the app from
 * starting when any route has none. QA's authorization matrix is generated
 * from `routes()`.
 */
@Injectable()
export class PolicyRegistry implements OnApplicationBootstrap {
  private cache: RouteEntry[] | null = null;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const missing = this.routes().filter((route) => route.policy === null);
    if (missing.length > 0) {
      const list = missing
        .map((route) => `  - ${route.method} ${route.path} (${route.controller}.${route.handler})`)
        .join('\n');
      throw new Error(
        `Every endpoint must declare @Policy or @Public (API design 6.4). Missing on:\n${list}`,
      );
    }
  }

  routes(): RouteEntry[] {
    if (this.cache) return this.cache;
    const entries: RouteEntry[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const controllerPath = this.reflector.get<string | string[]>(PATH_METADATA, metatype);
      const controllerPaths = Array.isArray(controllerPath) ? controllerPath : [controllerPath];
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[methodName] as () => unknown;
        const routePath = this.reflector.get<string | string[] | undefined>(PATH_METADATA, handler);
        if (routePath === undefined) continue;
        const requestMethod = this.reflector.get<RequestMethod>(METHOD_METADATA, handler);
        const policy =
          this.reflector.getAllAndOverride<RoutePolicy | undefined>(POLICY_METADATA, [
            handler,
            metatype,
          ]) ?? null;
        const routePaths = Array.isArray(routePath) ? routePath : [routePath];
        for (const base of controllerPaths) {
          for (const sub of routePaths) {
            const local = joinPath(base, sub);
            entries.push({
              method: RequestMethod[requestMethod] ?? String(requestMethod),
              path: isUnprefixedPath(local) ? local : joinPath(API_PREFIX, local),
              controller: metatype.name,
              handler: methodName,
              policy,
            });
          }
        }
      }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    this.cache = entries;
    return entries;
  }
}
