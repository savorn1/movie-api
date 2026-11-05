import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CommentDto {
  @IsInt() @Min(1) seriesId!: number;
  @IsInt() @Min(1) episode!: number;
  @IsString() @MinLength(1) @MaxLength(500) body!: string;
  /** Seconds into the episode, when written while watching (floats over the video) */
  @IsOptional() @IsInt() @Min(0) @Max(86_400) atSeconds?: number;
}

/** A browser's Web Push subscription (PushSubscription.toJSON()) */
export class PushSubscriptionDto {
  @IsString() @Matches(/^https:\/\//) @MaxLength(1000) endpoint!: string;
  @IsString() @MaxLength(200) p256dh!: string;
  @IsString() @MaxLength(100) auth!: string;
  @IsOptional() @IsInt() @Min(1) viewerId?: number;
}

export class PushEndpointDto {
  @IsString() @MaxLength(1000) endpoint!: string;
}

export class PushFollowDto extends PushEndpointDto {
  @IsInt() @Min(1) seriesId!: number;
  @IsBoolean() follow!: boolean;
}

export class CommentLikeDto {
  @IsBoolean()
  like!: boolean;
}
