import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig, type AppConfig } from './config';
import { DbTime } from './common/db-time';
import { PrismaService } from './prisma/prisma.service';

/** Settings, database access and time conversion, available to every module */
@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    {
      provide: DbTime,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => new DbTime(c.dbTimeZone),
    },
    PrismaService,
  ],
  exports: [APP_CONFIG, DbTime, PrismaService],
})
export class CoreModule {}
