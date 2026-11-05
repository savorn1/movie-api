import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { CommerceService } from './commerce.service';
import {
  AdminActionDto,
  GrantCoinsDto,
  OrderDto,
  RefundDto,
  UnlockDto,
} from './commerce.dto';

/**
 * Payments and coins. /viewers/:id/… is called by RuengFlix's server for its signed-in viewer;
 * /orders/:id/{paid,cancel} by the VideoLingo admin portal. Both carry MOVIE_API_TOKEN.
 */
@Controller()
export class CommerceController {
  constructor(private readonly commerce: CommerceService) {}

  @Get('viewers/:id/wallet')
  wallet(@Param('id', ParseIntPipe) id: number) {
    return this.commerce.wallet(id);
  }

  @Post('viewers/:id/check-in')
  @HttpCode(200)
  checkIn(@Param('id', ParseIntPipe) id: number) {
    return this.commerce.checkIn(id);
  }

  @Post('viewers/:id/unlocks')
  @HttpCode(200)
  unlock(@Param('id', ParseIntPipe) id: number, @Body() body: UnlockDto) {
    return this.commerce.unlockEpisode(id, body.seriesId, body.episode);
  }

  @Get('viewers/:id/coins')
  ledger(@Param('id', ParseIntPipe) id: number) {
    return this.commerce.ledger(id);
  }

  @Post('viewers/:id/orders')
  createOrder(@Param('id', ParseIntPipe) id: number, @Body() body: OrderDto) {
    return this.commerce.createOrder(id, body);
  }

  @Get('viewers/:id/orders')
  orders(@Param('id', ParseIntPipe) id: number) {
    return this.commerce.orders(id);
  }

  @Get('viewers/:id/orders/:orderId')
  order(
    @Param('id', ParseIntPipe) id: number,
    @Param('orderId', ParseIntPipe) orderId: number,
  ) {
    return this.commerce.order(id, orderId);
  }

  @Post('orders/:id/paid')
  @HttpCode(200)
  async paid(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AdminActionDto,
  ) {
    const order = await this.commerce.markPaid(id, { by: body.by });
    return { id: Number(order.id), status: order.status };
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  async cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AdminActionDto,
  ) {
    const order = await this.commerce.cancel(id, body.by);
    return { id: Number(order.id), status: order.status };
  }

  /** Paid orders the viewer hasn't been told about (paid after closing the KHQR screen) */
  @Get('viewers/:id/orders-news')
  news(@Param('id', ParseIntPipe) id: number) {
    return this.commerce.paidNews(id);
  }

  @Post('viewers/:id/orders/:orderId/seen')
  @HttpCode(204)
  seen(
    @Param('id', ParseIntPipe) id: number,
    @Param('orderId', ParseIntPipe) orderId: number,
  ) {
    return this.commerce.markSeen(id, orderId);
  }

  @Post('orders/:id/refund')
  @HttpCode(200)
  refund(@Param('id', ParseIntPipe) id: number, @Body() body: RefundDto) {
    return this.commerce.refund(id, body.by, body.reason);
  }

  @Post('viewers/:id/coins/grant')
  @HttpCode(200)
  grant(@Param('id', ParseIntPipe) id: number, @Body() body: GrantCoinsDto) {
    return this.commerce.grantCoins(id, body.coins, body.by, body.reason);
  }
}
