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
import { ViewersController } from './viewers/viewers.controller';
import { ViewersService } from './viewers/viewers.service';
import { CommerceController } from './commerce/commerce.controller';
import { CommerceService } from './commerce/commerce.service';
import { EngagementController } from './engagement/engagement.controller';
import { EngagementService } from './engagement/engagement.service';

@Module({
  imports: [CoreModule, MediaModule],
  controllers: [
    CatalogController,
    ViewerController,
    SiteController,
    ViewersController,
    CommerceController,
    EngagementController,
    HealthController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: TokenGuard },
    CatalogService,
    ViewerService,
    ViewersService,
    CommerceService,
    EngagementService,
  ],
})
export class AppModule {}
