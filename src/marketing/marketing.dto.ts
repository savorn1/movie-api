import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class StartAdDto {
  @IsInt() @Min(1) seriesId!: number;
  @IsInt() @Min(1) episode!: number;
}

/** A clip of the `seconds` before `at` (seconds into the episode) */
export class ClipDto {
  @IsInt() @Min(1) seriesId!: number;
  @IsInt() @Min(1) episode!: number;
  @IsInt() @Min(0) @Max(86_400) at!: number;
  @IsOptional() @IsInt() @Min(3) @Max(15) seconds?: number;
}

export class ReminderSentDto {
  @IsInt() @Min(1) viewerId!: number;
  @IsInt() @Min(1) seriesId!: number;
  @IsInt() @Min(1) episode!: number;
}
