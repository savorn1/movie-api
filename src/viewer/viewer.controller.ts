import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ViewerService } from './viewer.service';
import {
  AlertLogDto,
  FollowDto,
  PlayDto,
  ReportDto,
  ResolveDto,
  VoteDto,
} from './viewer.dto';

@Controller()
export class ViewerController {
  constructor(private readonly viewer: ViewerService) {}

  @Post('plays')
  @HttpCode(204)
  play(@Body() body: PlayDto) {
    return this.viewer.recordPlay(body);
  }

  @Post('votes')
  @HttpCode(200)
  vote(@Body() body: VoteDto) {
    return this.viewer.vote(body);
  }

  @Get('series/:id/stats')
  stats(@Param('id', ParseIntPipe) id: number) {
    return this.viewer.episodeStats(id);
  }

  @Get('likes')
  likes() {
    return this.viewer.likesBySeries();
  }

  @Post('reports')
  report(@Body() body: ReportDto) {
    return this.viewer.report(body);
  }

  @Get('reports')
  reports(
    @Query('includeResolved', new ParseBoolPipe({ optional: true }))
    includeResolved?: boolean,
  ) {
    return this.viewer.reports(includeResolved ?? false);
  }

  @Put('reports/:id')
  resolve(@Param('id', ParseIntPipe) id: number, @Body() body: ResolveDto) {
    return this.viewer.resolve(id, body.resolved, body.resolvedBy);
  }

  @Post('follows')
  @HttpCode(204)
  follow(@Body() body: FollowDto) {
    return this.viewer.follow(body);
  }

  @Delete('follows/:seriesId/:chatId')
  @HttpCode(204)
  unfollow(
    @Param('seriesId', ParseIntPipe) seriesId: number,
    @Param('chatId', ParseIntPipe) chatId: number,
  ) {
    return this.viewer.unfollow(seriesId, chatId);
  }

  @Get('series/:id/followers')
  followers(@Param('id', ParseIntPipe) id: number) {
    return this.viewer.followers(id);
  }

  @Get('chats/:chatId/follows')
  followedBy(@Param('chatId', ParseIntPipe) chatId: number) {
    return this.viewer.followedBy(chatId);
  }

  @Delete('chats/:chatId/follows')
  unfollowAll(@Param('chatId', ParseIntPipe) chatId: number) {
    return this.viewer.unfollowAll(chatId);
  }

  @Post('series/:id/alerts')
  @HttpCode(200)
  claimAlert(@Param('id', ParseIntPipe) id: number) {
    return this.viewer.claimAlert(id);
  }

  @Post('series/:id/alerts/log')
  @HttpCode(204)
  logAlert(@Param('id', ParseIntPipe) id: number, @Body() body: AlertLogDto) {
    return this.viewer.logAlert(id, body);
  }
}
