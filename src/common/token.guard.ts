import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config';

const PUBLIC = 'movie-api:public';
/** Marks a route as reachable without the token (health checks) */
export const Public = () => SetMetadata(PUBLIC, true);

/**
 * Every route needs `Authorization: Bearer <MOVIE_API_TOKEN>`: movie-api is called only by RuengFlix's
 * server, never by browsers, so viewers' rate limits live on RuengFlix.
 */
@Injectable()
export class TokenGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.expected = digest(config.token);
  }

  canActivate(context: ExecutionContext): boolean {
    const open = this.reflector.getAllAndOverride<boolean>(PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (open) return true;
    const header =
      context.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    // Compare digests so the comparison takes the same time whatever the length
    if (given && timingSafeEqual(digest(given), this.expected)) return true;
    throw new UnauthorizedException('Missing or wrong token');
  }
}

const digest = (s: string) => createHash('sha256').update(s).digest();
