import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class OrderDto {
  @IsIn(['COINS', 'SERIES', 'VIP']) kind!: 'COINS' | 'SERIES' | 'VIP';
  @IsOptional() @IsInt() coins?: number;
  @IsOptional() @IsInt() months?: number;
  @IsOptional() @IsInt() @Min(1) seriesId?: number;
  /** Bought for someone else (coins or VIP): paying it makes a gift code */
  @IsOptional() @IsBoolean() gift?: boolean;
  @IsOptional() @IsString() @MaxLength(140) giftMessage?: string;
}

export class RedeemGiftDto {
  @IsString() @MinLength(6) @MaxLength(24) code!: string;
}

export class UnlockDto {
  @IsInt() @Min(1) seriesId!: number;
  @IsInt() @Min(1) episode!: number;
}

/** Who confirmed or cancelled an order in the admin portal */
export class AdminActionDto {
  @IsString() @MaxLength(100) by!: string;
}

/** An admin refund: who and why (shown in the admin portal and the logs) */
export class RefundDto {
  @IsString() @MaxLength(100) by!: string;
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

/** An admin gives (or takes back) coins for a support case */
export class GrantCoinsDto {
  @IsInt() @Min(-10000) @Max(10000) coins!: number;
  @IsString() @MaxLength(100) by!: string;
  @IsString() @MinLength(3) @MaxLength(200) reason!: string;
}
