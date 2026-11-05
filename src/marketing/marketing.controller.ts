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
import { MarketingService } from './marketing.service';
import { CommerceService } from '../commerce/commerce.service';
import { RedeemGiftDto } from '../commerce/commerce.dto';
import { normalizeCode } from './rules';
import { ClipDto, ReminderSentDto, StartAdDto } from './marketing.dto';

const viewerPipe = new ParseIntPipe({ optional: true });

/**
 * Promotions, rewarded ads, gifts, clips and "you stopped at…" reminders. Called by RuengFlix's
 * server (MOVIE_API_TOKEN), for its signed-in viewer under /viewers/:id/….
 */
@Controller()
export class MarketingController {
  constructor(
    private readonly marketing: MarketingService,
    private readonly commerce: CommerceService,
  ) {}

  @Get('promotions')
  promotions() {
    return this.marketing.activePromotions();
  }

  @Post('viewers/:id/ads')
  startAd(@Param('id', ParseIntPipe) id: number, @Body() body: StartAdDto) {
    return this.marketing.startAd(id, body.seriesId, body.episode);
  }

  @Post('viewers/:id/ads/:viewId/complete')
  @HttpCode(200)
  completeAd(
    @Param('id', ParseIntPipe) id: number,
    @Param('viewId', ParseIntPipe) viewId: number,
  ) {
    return this.marketing.completeAd(id, viewId);
  }

  @Get('gifts/:code')
  gift(@Param('code') code: string) {
    return this.commerce.giftInfo(normalizeCode(code));
  }

  @Post('viewers/:id/gifts/redeem')
  @HttpCode(200)
  redeem(@Param('id', ParseIntPipe) id: number, @Body() body: RedeemGiftDto) {
    return this.commerce.redeemGift(id, normalizeCode(body.code));
  }

  @Get('viewers/:id/gifts')
  myGifts(@Param('id', ParseIntPipe) id: number) {
    return this.commerce.myGifts(id);
  }

  /** ?viewer=<id> for an episode they paid for */
  @Post('clips')
  createClip(
    @Body() body: ClipDto,
    @Query('viewer', viewerPipe) viewer?: number,
  ) {
    return this.marketing.createClip(
      viewer,
      body.seriesId,
      body.episode,
      body.at,
      body.seconds ?? 15,
    );
  }

  @Get('clips/:code')
  clip(@Param('code') code: string) {
    return this.marketing.clip(normalizeCode(code));
  }

  @Post('clips/:code/view')
  @HttpCode(204)
  viewClip(@Param('code') code: string) {
    return this.marketing.viewClip(normalizeCode(code));
  }

  @Get('resume-reminders')
  dueReminders(@Query('limit') limit = '200') {
    return this.marketing.dueResumeReminders(
      Math.min(500, Math.max(1, Number(limit) || 200)),
    );
  }

  @Post('resume-reminders/sent')
  @HttpCode(200)
  reminded(@Body() body: ReminderSentDto) {
    return this.marketing.markReminded(
      body.viewerId,
      body.seriesId,
      body.episode,
    );
  }
}
