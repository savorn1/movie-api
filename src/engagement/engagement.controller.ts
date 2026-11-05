import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { EngagementService } from './engagement.service';
import {
  CommentDto,
  CommentLikeDto,
  PushEndpointDto,
  PushFollowDto,
  PushSubscriptionDto,
} from './engagement.dto';

@Controller()
export class EngagementController {
  constructor(private readonly engagement: EngagementService) {}

  @Get('series/:id/episodes/:ep/comments')
  comments(
    @Param('id', ParseIntPipe) id: number,
    @Param('ep', ParseIntPipe) ep: number,
    @Query('viewer', new ParseIntPipe({ optional: true })) viewer?: number,
  ) {
    return this.engagement.comments(id, ep, viewer);
  }

  @Get('series/:id/episodes/:ep/timed-comments')
  timed(
    @Param('id', ParseIntPipe) id: number,
    @Param('ep', ParseIntPipe) ep: number,
  ) {
    return this.engagement.timedComments(id, ep);
  }

  @Get('viewers/:id/fan')
  fan(@Param('id', ParseIntPipe) id: number) {
    return this.engagement.fan(id);
  }

  @Post('viewers/:id/comments')
  addComment(@Param('id', ParseIntPipe) id: number, @Body() body: CommentDto) {
    return this.engagement.addComment(id, body);
  }

  @Delete('viewers/:id/comments/:commentId')
  @HttpCode(204)
  deleteComment(
    @Param('id', ParseIntPipe) id: number,
    @Param('commentId', ParseIntPipe) commentId: number,
  ) {
    return this.engagement.deleteComment(id, commentId);
  }

  @Put('viewers/:id/comments/:commentId/like')
  likeComment(
    @Param('id', ParseIntPipe) id: number,
    @Param('commentId', ParseIntPipe) commentId: number,
    @Body() body: CommentLikeDto,
  ) {
    return this.engagement.likeComment(id, commentId, body.like);
  }

  @Post('viewers/:id/comments/:commentId/report')
  @HttpCode(204)
  reportComment(
    @Param('id', ParseIntPipe) id: number,
    @Param('commentId', ParseIntPipe) commentId: number,
  ) {
    return this.engagement.reportComment(id, commentId);
  }

  @Put('push/subscriptions')
  subscribe(@Body() body: PushSubscriptionDto) {
    return this.engagement.subscribe(body);
  }

  @Post('push/subscriptions/remove')
  @HttpCode(204)
  unsubscribe(@Body() body: PushEndpointDto) {
    return this.engagement.unsubscribe(body.endpoint);
  }

  @Delete('push/subscriptions/:id')
  @HttpCode(204)
  drop(@Param('id', ParseIntPipe) id: number) {
    return this.engagement.dropSubscription(id);
  }

  @Post('push/follows')
  @HttpCode(204)
  pushFollow(@Body() body: PushFollowDto) {
    return this.engagement.setPushFollow(
      body.endpoint,
      body.seriesId,
      body.follow,
    );
  }

  @Get('series/:id/push')
  pushTargets(@Param('id', ParseIntPipe) id: number) {
    return this.engagement.pushTargets(id);
  }

  @Post('viewers/:id/active')
  @HttpCode(204)
  active(@Param('id', ParseIntPipe) id: number) {
    return this.engagement.active(id);
  }

  /** ?series=1,2,3&limit=12 */
  @Get('recommendations')
  recommendations(@Query('series') series = '', @Query('limit') limit = '12') {
    const ids = series
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 30);
    return this.engagement.recommendations(
      ids,
      Math.min(30, Math.max(1, Number(limit) || 12)),
    );
  }
}
