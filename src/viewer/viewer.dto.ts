import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

class EpisodeRef {
  @Type(() => Number) @IsInt() @Min(1) seriesId!: number;
  @Type(() => Number) @IsInt() @Min(1) episode!: number;
}

export class PlayDto extends EpisodeRef {
  /** WALL: the unlock screen was shown for this episode (paywall analytics) */
  @IsIn(['START', 'COMPLETE', 'WALL']) event!: 'START' | 'COMPLETE' | 'WALL';
}

/** vote: 1 = 👍, -1 = 👎, 0 = cleared; previous: the viewer's vote before this one */
export class VoteDto extends EpisodeRef {
  @IsInt() @Min(-1) @Max(1) vote!: number;
  @IsOptional() @IsInt() @Min(-1) @Max(1) previous?: number;
}

export const REPORT_REASONS = ['VIDEO', 'SUBTITLES', 'AUDIO', 'OTHER'] as const;

export class ReportDto extends EpisodeRef {
  @IsIn(REPORT_REASONS) reason!: (typeof REPORT_REASONS)[number];
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsInt() @Min(0) positionSeconds?: number;
}

export class ResolveDto {
  @IsBoolean() resolved!: boolean;
  /** Who resolved it, as shown in VideoLingo's database (e.g. "RuengFlix admin") */
  @IsOptional() @IsString() @MaxLength(100) resolvedBy?: string;
}

export class FollowDto {
  @IsInt() @Min(1) seriesId!: number;
  // Telegram chat ids: positive for people, negative for groups
  @IsInt() chatId!: number;
}

/** What RuengFlix reports after messaging a series' followers about an episode */
export class AlertLogDto {
  @IsInt() @Min(1) episode!: number;
  @IsIn(['AUTO', 'MANUAL']) source!: 'AUTO' | 'MANUAL';
  @IsInt() @Min(0) followers!: number;
  @IsInt() @Min(0) sent!: number;
  @IsInt() @Min(0) removed!: number;
  @IsInt() @Min(0) failed!: number;
}
