import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CoreModule } from './core.module';
import { TokenGuard } from './common/token.guard';
import { MediaModule } from './media/media.module';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { ViewerController } from './viewer/viewer.controller';
import { ViewerService } from './viewer/viewer.service';
import { HealthController } from './health.controller';
import { SiteController } from './site/site.controller';

@Module({
  imports: [CoreModule, MediaModule],
  controllers: [
    CatalogController,
    ViewerController,
    SiteController,
    HealthController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: TokenGuard },
    CatalogService,
    ViewerService,
  ],
})
export class AppModule {}
