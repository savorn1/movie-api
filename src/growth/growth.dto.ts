import {
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { REACTIONS } from './rules';

export class WatchDto {
  @IsInt() @Min(1) seriesId!: number;
  @IsInt() @Min(1) episode!: number;
}

export class InviteDto {
  @IsString() @MaxLength(32) code!: string;
}

export class ReactionDto {
  @IsNumber() @Min(0) @Max(24 * 3600) second!: number;
  @IsIn(REACTIONS) kind!: string;
}

export class SearchDto {
  @IsString() @MaxLength(200) term!: string;
}
