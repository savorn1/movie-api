import { Controller, Get } from '@nestjs/common';
import { Public } from './common/token.guard';
import { PrismaService } from './prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** For load balancers: 200 when the database answers */
  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`select 1`;
    return { status: 'ok' };
  }
}
