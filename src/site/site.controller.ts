import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { pricesFrom, type Prices } from './prices';

/** Site-wide settings RuengFlix shows, edited in videolingo-web */
@Controller('site')
export class SiteController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async site(): Promise<{ prices: Prices }> {
    const row = await this.prisma.appSetting.findUnique({
      where: { section: 'streaming' },
      select: { valueJson: true },
    });
    return { prices: pricesFrom(row?.valueJson) };
  }
}
