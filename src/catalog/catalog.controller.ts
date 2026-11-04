import {
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { CatalogService } from './catalog.service';

/** ?viewer=<id>: RuengFlix's signed-in viewer, so the VIP episodes they paid for come with links */
const viewerPipe = new ParseIntPipe({ optional: true });

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('series')
  series() {
    return this.catalog.list();
  }

  /** ?days=7: episodes scheduled to come out soon */
  @Get('schedule')
  schedule(@Query('days') days = '7') {
    return this.catalog.schedule(Math.min(31, Math.max(1, Number(days) || 7)));
  }

  @Get('series/:id')
  seriesDetail(
    @Param('id', ParseIntPipe) id: number,
    @Query('viewer', viewerPipe) viewer?: number,
  ) {
    return this.catalog.get(id, viewer);
  }

  @Get('episodes/:videoId/subtitles.vtt')
  @Header('Content-Type', 'text/vtt; charset=utf-8')
  subtitles(
    @Param('videoId', ParseIntPipe) videoId: number,
    @Query('viewer', viewerPipe) viewer?: number,
  ) {
    return this.catalog.subtitlesVtt(videoId, viewer);
  }
}
