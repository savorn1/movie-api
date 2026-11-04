import { Controller, Get, Header, Param, ParseIntPipe } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('series')
  series() {
    return this.catalog.list();
  }

  @Get('series/:id')
  seriesDetail(@Param('id', ParseIntPipe) id: number) {
    return this.catalog.get(id);
  }

  @Get('episodes/:videoId/subtitles.vtt')
  @Header('Content-Type', 'text/vtt; charset=utf-8')
  subtitles(@Param('videoId', ParseIntPipe) videoId: number) {
    return this.catalog.subtitlesVtt(videoId);
  }
}
