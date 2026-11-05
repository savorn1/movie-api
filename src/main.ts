import { existsSync } from 'node:fs';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadConfig } from './config';

async function bootstrap() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // A viewer's synced library can be up to 256 KB (ViewersService.MAX_LIBRARY_BYTES)
  app.useBodyParser('json', { limit: '300kb' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
  // API docs at /docs (JSON at /docs-json). Off in production: movie-api is server-to-server only.
  if (process.env.NODE_ENV !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle('movie-api')
      .setDescription(
        'RuengFlix backend. Every route except /health needs Bearer MOVIE_API_TOKEN.',
      )
      .setVersion('0.0.1')
      .addBearerAuth()
      .addSecurityRequirements('bearer')
      .build();
    SwaggerModule.setup('docs', app, () =>
      SwaggerModule.createDocument(app, doc),
    );
  }
  await app.listen(config.port);
  new Logger('movie-api').log(
    `Listening on ${config.port} (database times in ${config.dbTimeZone})`,
  );
}
void bootstrap();
