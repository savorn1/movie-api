import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { GrowthService } from './growth.service';
import { InviteDto, ReactionDto, SearchDto, WatchDto } from './growth.dto';

/** Missions, invites, reactions, trending searches and VIP reminders; called by RuengFlix's server */
@Controller()
export class GrowthController {
  constructor(private readonly growth: GrowthService) {}

  @Get('viewers/:id/missions')
  missions(@Param('id', ParseIntPipe) id: number) {
    return this.growth.missions(id);
  }

  @Post('viewers/:id/watches')
  @HttpCode(200)
  watched(@Param('id', ParseIntPipe) id: number, @Body() body: WatchDto) {
    return this.growth.recordWatch(id, body.seriesId, body.episode);
  }

  @Post('viewers/:id/missions/:key/claim')
  @HttpCode(200)
  claim(@Param('id', ParseIntPipe) id: number, @Param('key') key: string) {
    return this.growth.claimMission(id, key);
  }

  @Get('viewers/:id/invite')
  invite(@Param('id', ParseIntPipe) id: number) {
    return this.growth.invite(id);
  }

  @Post('viewers/:id/invited-by')
  @HttpCode(200)
  invitedBy(@Param('id', ParseIntPipe) id: number, @Body() body: InviteDto) {
    return this.growth.acceptInvite(id, body.code);
  }

  @Get('series/:id/episodes/:ep/reactions')
  reactions(
    @Param('id', ParseIntPipe) id: number,
    @Param('ep', ParseIntPipe) ep: number,
  ) {
    return this.growth.reactions(id, ep);
  }

  @Post('series/:id/episodes/:ep/reactions')
  @HttpCode(200)
  react(
    @Param('id', ParseIntPipe) id: number,
    @Param('ep', ParseIntPipe) ep: number,
    @Body() body: ReactionDto,
  ) {
    return this.growth.react(id, ep, body.second, body.kind);
  }

  @Post('search/terms')
  @HttpCode(200)
  search(@Body() body: SearchDto) {
    return this.growth.logSearch(body.term);
  }

  @Get('search/trending')
  trending(@Query('limit') limit?: string) {
    return this.growth.trending(Number(limit) || 8);
  }

  @Post('vip-reminders/claim')
  @HttpCode(200)
  vipReminders() {
    return this.growth.claimVipReminders();
  }
}
