import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class OrderDto {
  @IsIn(['COINS', 'SERIES', 'VIP']) kind!: 'COINS' | 'SERIES' | 'VIP';
  @IsOptional() @IsInt() coins?: number;
  @IsOptional() @IsInt() months?: number;
  @IsOptional() @IsInt() @Min(1) seriesId?: number;
}

export class UnlockDto {
  @IsInt() @Min(1) seriesId!: number;
  @IsInt() @Min(1) episode!: number;
}

/** Who confirmed or cancelled an order in the admin portal */
export class AdminActionDto {
  @IsString() @MaxLength(100) by!: string;
}
