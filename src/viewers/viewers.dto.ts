import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PASSWORD_MAX, PASSWORD_MIN } from './password';

export class RegisterDto {
  /** As typed; normalized to E.164 by the service */
  @IsString() @MaxLength(30) phone!: string;
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password!: string;
  @IsString() @MinLength(1) @MaxLength(60) displayName!: string;
}

export class LoginDto {
  @IsString() @MaxLength(30) phone!: string;
  @IsString() @MaxLength(PASSWORD_MAX) password!: string;
}

export class ChangePasswordDto {
  @IsOptional() @IsString() @MaxLength(PASSWORD_MAX) current?: string;
  /** Skip `current`: the viewer just signed in with Telegram or Google (RuengFlix checks) */
  @IsOptional() @IsBoolean() reset?: boolean;
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  next!: string;
}

export class LibraryDto {
  @IsObject() data!: Record<string, unknown>;
}

/**
 * A Telegram or Google account RuengFlix's server has already verified (Telegram's signed login data,
 * Google's ID token). Signs in the viewer it belongs to, creates one, or with `linkTo` adds it to
 * that viewer's account.
 */
export class IdentityDto {
  @IsIn(['telegram', 'google']) provider!: 'telegram' | 'google';
  /** Telegram user id (digits) or Google "sub" */
  @IsString() @Matches(/^[\w-]{1,255}$/) subject!: string;
  @IsString() @MaxLength(200) displayName!: string;
  @IsOptional() @IsString() @MaxLength(64) username?: string;
  @IsOptional() @IsString() @MaxLength(320) email?: string;
  @IsOptional() @IsString() @MaxLength(1000) photoUrl?: string;
  @IsOptional() @IsInt() @Min(1) linkTo?: number;
}
