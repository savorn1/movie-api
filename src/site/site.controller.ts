import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { homeRowsFrom, type HomeRow } from './homeRows';
import { pricesFrom, type Prices } from './prices';

/** Site-wide settings RuengFlix shows (prices, home page rows), edited in videolingo-web */
@Controller('site')
export class SiteController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async site(): Promise<{ prices: Prices; homeRows: HomeRow[] }> {
    const [row, rows] = await Promise.all([
      this.prisma.appSetting.findUnique({
        where: { section: 'streaming' },
        select: { valueJson: true },
      }),
      this.prisma.homeRow
        .findMany({
          where: { active: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: { title: true, source: true, value: true, maxItems: true },
        })
        // Before VideoLingo's V25 adds the table: RuengFlix keeps its built-in rows, and the prices still load
        .catch(() => []),
    ]);
    return { prices: pricesFrom(row?.valueJson), homeRows: homeRowsFrom(rows) };
  }
}
